/**
 * One desktop shell generation: the window, its listeners, and the renderer
 * capability, owned together and released together.
 *
 * A profile or mode switch disposes the whole generation and starts a new one.
 * Nothing here may be cached across generations — a stale `BrowserWindow` or a
 * stale header disposer would attach this generation's capability to the next
 * generation's traffic.
 */

import { fileURLToPath } from 'node:url';

import { BrowserWindow, shell } from 'electron';

import { createRendererAccessHeader } from './browser-access.js';
import { blocksNavigation, externalPopupTarget } from './navigation-policy.js';
import {
  authenticateRendererSession,
  installRendererAccessHeader,
} from './renderer-session.js';
import { installMacTitlebar } from './titlebar.js';

/** Sandboxed preload that marks the document as the macOS desktop shell. */
const PLATFORM_MARK_PRELOAD = fileURLToPath(
  new URL('../preload/platform-mark.cjs', import.meta.url),
);

/** Persistent partition isolated from the default and any auxiliary session. */
export const RENDERER_SESSION_PARTITION = 'persist:dsh-desktop-renderer';

export class ShellGeneration {
  #window;
  #accessHeader;
  #removeAccessHeader;
  #released = false;
  #log;

  /**
   * @param options - `{ log }` shell diagnostics sink.
   */
  constructor(options) {
    this.#log = options.log;
  }

  /**
   * Create the window, admit its session, and load the carrier page.
   *
   * Ordering matters and is the whole point of this method:
   * 1. create the window so its partitioned session exists;
   * 2. exchange the launch token inside that session (no page loaded yet);
   * 3. install the capability header before any request is issued;
   * 4. navigate to the clean origin, which the cookie now authorizes.
   *
   * @param spec - `{ origin, authenticationUrl, title }`.
   */
  async mount(spec) {
    const accessHeader = createRendererAccessHeader();
    this.#accessHeader = accessHeader;

    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title: spec.title,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#202124',
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // No Electron API reaches the page: the desktop adds no renderer IPC
        // plugin system, so the strict sandbox stays on — the preload below
        // runs sandboxed too and exposes nothing.
        sandbox: true,
        webSecurity: true,
        partition: RENDERER_SESSION_PARTITION,
        // Sets only `<html data-platform="darwin">`, which switches the
        // upstream client to its hidden-inset titlebar layout (native drag
        // regions, traffic-light room). It bridges nothing into the page.
        preload: PLATFORM_MARK_PRELOAD,
      },
    });
    this.#window = window;

    const renderer = window.webContents;

    // Make the top edge behave like the native titlebar hiddenInset removed:
    // drag to move, double-click to zoom (per the system setting).
    installMacTitlebar(renderer, this.#log);

    // The window is created hidden so the first paint is the loaded client
    // rather than an empty frame.
    window.once('ready-to-show', () => {
      this.show();
    });

    // A popup never becomes a second app frame. Only web and mail targets are
    // handed to the system: passing an arbitrary scheme to `openExternal` would
    // let page content invoke whatever handler the OS has registered for it.
    renderer.setWindowOpenHandler(({ url }) => {
      const external = externalPopupTarget(url);
      if (external !== undefined) {
        void shell.openExternal(external).catch((cause) => {
          this.#log(`failed to open external link: ${String(cause)}`);
        });
      }
      return { action: 'deny' };
    });

    // Confine top-level navigation to the carrier origin. Off-origin targets are
    // only blocked, never forwarded to the browser: `will-frame-navigate` also
    // fires for internal targets such as `about:blank`, and silently launching
    // those would be wrong. Subframe navigation is left alone so the client's
    // own embedded views keep working.
    renderer.on('will-frame-navigate', (event) => {
      if (blocksNavigation(event.url, spec.origin, event.isMainFrame)) {
        event.preventDefault();
      }
    });

    // A redirect can leave the origin without raising `will-frame-navigate`.
    renderer.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
      if (blocksNavigation(url, spec.origin, isMainFrame)) event.preventDefault();
    });

    renderer.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      this.#log(
        `did-fail-load ${String(code)} ${description} url=${url} main=${String(isMainFrame)}`,
      );
    });

    renderer.on('render-process-gone', (_event, details) => {
      this.#log(`renderer gone: ${JSON.stringify(details)}`);
    });

    try {
      await authenticateRendererSession(
        renderer.session,
        spec.authenticationUrl,
        accessHeader,
      );
      this.#log('renderer session authenticated');

      this.#removeAccessHeader = installRendererAccessHeader(
        renderer,
        spec.origin,
        accessHeader,
      );

      await window.loadURL(spec.origin);
      this.#log(`loaded ${spec.origin}`);

      if (spec.verifyClient === true) await this.#verifyClientMounted(renderer);
    } catch (cause) {
      await this.release();
      throw cause;
    }
  }

  /**
   * Confirm the client actually mounted, rather than trusting `loadURL`.
   *
   * `loadURL` resolves once the document is committed, which a blank page or an
   * error page also satisfies. The checks below are the observable consequences
   * of the upstream client booting: the injected boot payload is present, the
   * plugin bundles registered their modules, and React rendered into the root.
   *
   * @param renderer - the window's `webContents`.
   */
  async #verifyClientMounted(renderer) {
    const deadline = Date.now() + 30_000;
    let lastSeen = 'nothing yet';

    while (Date.now() < deadline) {
      const state = await renderer.executeJavaScript(
        `(() => {
          const root = document.getElementById('root') ?? document.body.firstElementChild;
          return {
            title: document.title,
            hasBoot: typeof globalThis.__DSH_BOOT__ === 'object' && globalThis.__DSH_BOOT__ !== null,
            rootChildren: root === null ? 0 : root.childElementCount,
            text: (document.body.innerText ?? '').trim().slice(0, 120),
          };
        })()`,
        true,
      );
      lastSeen = JSON.stringify(state);
      if (state.hasBoot === true && state.rootChildren > 0) {
        this.#log(`client mounted: ${lastSeen}`);
        await this.#verifyTitlebar(renderer);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`dsh-desktop: the client did not mount in time; last saw ${lastSeen}`);
  }

  /**
   * Confirm the macOS titlebar layout is active: the preload marked the
   * document, and the page exposes at least one native drag region along its
   * top edge (where the hidden titlebar used to be).
   *
   * @param renderer - the window's `webContents`.
   * @throws on macOS when the mark or the drag regions are missing.
   */
  async #verifyTitlebar(renderer) {
    if (process.platform !== 'darwin') return;
    const state = await renderer.executeJavaScript(
      `(() => {
        const drag = [...document.querySelectorAll('*')]
          .filter((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag')
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
          })
          .filter(([, y, w, h]) => w > 0 && h > 0 && y < 60);
        // The window-wide strip is a pseudo-element, invisible to the query above.
        const strip = getComputedStyle(document.body, '::before');
        if (strip.getPropertyValue('-webkit-app-region') === 'drag' && strip.position === 'fixed') {
          drag.push([0, 0, innerWidth, Math.round(parseFloat(strip.height))]);
        }
        return { platform: document.documentElement.dataset.platform ?? null, drag };
      })()`,
      true,
    );
    this.#log(`titlebar: ${JSON.stringify(state)}`);
    const screenshot = process.env.DSH_DESKTOP_SMOKE_HOME_SCREENSHOT;
    if (screenshot !== undefined) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(screenshot, (await renderer.capturePage()).toPNG());
      this.#log(`home screenshot written to ${screenshot}`);
    }
    if (state.platform !== 'darwin' || state.drag.length === 0) {
      throw new Error(`dsh-desktop: the macOS titlebar drag regions are missing; saw ${JSON.stringify(state)}`);
    }
  }

  /**
   * Smoke check for the desktop Settings page: the branding plugin's client
   * bundle is in the boot graph and its routes accept this window's traffic.
   *
   * Runs the request from inside the page, so it exercises the real path — the
   * session cookie plus the capability header the renderer session attaches.
   *
   * @throws when the plugin is missing or a route rejects the window.
   */
  async verifyBrandingPage() {
    const window = this.#window;
    if (window === undefined || window.isDestroyed()) throw new Error('dsh-desktop: no window');
    const result = await window.webContents.executeJavaScript(
      `(async () => {
        const boot = globalThis.__DSH_BOOT__;
        const graph = JSON.stringify(boot ?? {});
        const response = await fetch('/api/dsh-desktop/branding', { cache: 'no-store' });
        const body = await response.json().catch(() => ({}));
        return {
          pluginInBootGraph: graph.includes('dsh-desktop-branding'),
          status: response.status,
          name: body.name,
          restartRequired: body.restartRequired,
        };
      })()`,
      true,
    );
    this.#log(`branding page: ${JSON.stringify(result)}`);
    if (result.pluginInBootGraph !== true) {
      throw new Error('dsh-desktop: the branding plugin is missing from the boot graph');
    }
    if (result.status !== 200 || typeof result.name !== 'string') {
      throw new Error(`dsh-desktop: branding route answered ${String(result.status)}`);
    }

    // Open Settings and the page itself, and confirm the section rendered
    // with its controls: the slot registration and the component, not just
    // the bundle's presence.
    const deadline = Date.now() + 15_000;
    let seen;
    while (Date.now() < deadline) {
      seen = await window.webContents.executeJavaScript(
        `(() => {
          const section = document.querySelector('.dshDesktopBranding');
          if (section !== null) {
            const box = (el) => {
              if (el === null) return null;
              const r = el.getBoundingClientRect();
              return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
            };
            const img = section.querySelector('img.icon');
            return {
              rendered: true,
              hasNameInput: section.querySelector('#dsh-desktop-app-name') !== null,
              buttons: [...section.querySelectorAll('button')].map((b) => b.textContent),
              hasIcon: img !== null,
              iconLoaded: img !== null && img.complete && img.naturalWidth > 0,
              layout: {
                viewport: [innerWidth, innerHeight],
                section: box(section),
                input: box(section.querySelector('input')),
                icon: box(img),
                activeNav: [...document.querySelectorAll('button')]
                  .filter((b) => /^(应用外观|Appearance)$/.test((b.textContent ?? '').trim()))
                  .map((b) => getComputedStyle(b).backgroundColor),
                headingFont: getComputedStyle(section.querySelector('h2')).fontSize,
                color: getComputedStyle(section).color,
              },
            };
          }
          const buttons = [...document.querySelectorAll('button')];
          const nav = buttons.find((b) => /^(应用外观|Appearance)$/.test((b.textContent ?? '').trim()));
          if (nav !== undefined) { nav.click(); return { rendered: false, step: 'nav' }; }
          const trigger = buttons.find((b) => /^(设置|Settings)$/.test((b.textContent ?? '').trim()));
          if (trigger !== undefined) { trigger.click(); return { rendered: false, step: 'trigger' }; }
          return { rendered: false, step: 'none' };
        })()`,
        true,
      );
      if (seen.rendered === true) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.#log(`branding section: ${JSON.stringify(seen)}`);
    const screenshot = process.env.DSH_DESKTOP_SMOKE_SCREENSHOT;
    if (screenshot !== undefined && seen?.rendered === true) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      this.#log(`screenshot written to ${screenshot}`);
    }
    if (seen?.rendered !== true || seen.hasNameInput !== true) {
      throw new Error(`dsh-desktop: the branding section did not render; last saw ${JSON.stringify(seen)}`);
    }
  }

  /**
   * Smoke check for keyboard shortcuts: fire the real menu items and confirm
   * the page reacted — ⌘, opens the Settings modal, ⌘/ opens the shortcuts
   * page, ⌘B toggles the sidebar.
   *
   * @param press - `(commandId) => void`, clicks the application menu item.
   * @throws when a command has no visible effect.
   */
  async verifyShortcuts(press) {
    const window = this.#window;
    if (window === undefined || window.isDestroyed()) throw new Error('dsh-desktop: no window');
    const probe = (expression) => window.webContents.executeJavaScript(expression, true);
    const until = async (label, expression) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if ((await probe(expression)) === true) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`dsh-desktop: shortcut check "${label}" failed`);
    };
    const modal = `document.querySelector('[role="dialog"][aria-modal="true"]')`;
    const escape = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;
    const collapsed = `document.querySelector('[data-sidebar-collapsed="true"]') !== null`;

    press('settings');
    await until('settings opens', `${modal} !== null`);
    await probe(escape);
    await until('settings closes', `${modal} === null`);

    press('shortcuts');
    await until('shortcuts page renders', `document.querySelector('.dshDesktopShortcuts kbd') !== null`);
    const screenshot = process.env.DSH_DESKTOP_SMOKE_SHORTCUTS_SCREENSHOT;
    if (screenshot !== undefined) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      this.#log(`shortcuts screenshot written to ${screenshot}`);
    }
    await probe(escape);
    await until('shortcuts page closes', `${modal} === null`);

    const before = await probe(collapsed);
    press('toggleSidebar');
    await until('sidebar toggles', `(${collapsed}) === ${String(!before)}`);
    press('toggleSidebar');
    await until('sidebar toggles back', `(${collapsed}) === ${String(before)}`);

    this.#log('shortcuts: settings, shortcuts page, and sidebar toggle respond');
  }

  /**
   * Test hook: rename and restart through the page's own requests, the same
   * calls the Settings section makes.
   * @param name - new display name.
   */
  async exerciseRename(name) {
    const window = this.#window;
    if (window === undefined || window.isDestroyed()) throw new Error('dsh-desktop: no window');
    const result = await window.webContents.executeJavaScript(
      `(async () => {
        const post = (path, body) => fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const saved = await (await post('/api/dsh-desktop/branding/name', { name: ${JSON.stringify(name)} })).json();
        const restart = await post('/api/dsh-desktop/branding/restart', {});
        return { saved, restartStatus: restart.status };
      })()`,
      true,
    );
    process.stdout.write(`dsh-desktop: rename exercised: ${JSON.stringify(result)}\n`);
  }

  /**
   * This generation's renderer capability, for host routes that must accept
   * only this window's traffic. `undefined` once released, so a route checked
   * after teardown fails closed.
   */
  get accessHeader() {
    return this.#released ? undefined : this.#accessHeader;
  }

  /** Whether the window is still usable. */
  get alive() {
    return this.#window !== undefined && !this.#window.isDestroyed();
  }

  /**
   * Deliver one keyboard-shortcut command to the page.
   *
   * A one-way push: the main process dispatches a DOM event that the
   * `dsh-desktop-shortcuts` client plugin handles. Nothing flows back and the
   * page gets no handle to call the main process with.
   *
   * @param script - the dispatch script from `commandScript` (already
   *   validated against the command table).
   */
  dispatchCommand(script) {
    const window = this.#window;
    if (window === undefined || window.isDestroyed()) return;
    // A command aimed at the app while it is hidden or minimised should also
    // bring it forward (⌘, from the menu bar, for instance).
    if (!window.isVisible() || window.isMinimized()) this.show();
    window.webContents.executeJavaScript(script, true).catch((cause) => {
      this.#log(`shortcut dispatch failed: ${String(cause)}`);
    });
  }

  /**
   * Bring the window forward, restoring it first if it was minimised.
   *
   * Safe to call at any point in the lifecycle: before the window exists, and
   * after release, it does nothing.
   */
  show() {
    const window = this.#window;
    if (window === undefined || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /**
   * Release every resource this generation owns. Idempotent.
   */
  async release() {
    if (this.#released) return;
    this.#released = true;

    this.#removeAccessHeader?.();
    this.#removeAccessHeader = undefined;
    this.#accessHeader = undefined;

    const window = this.#window;
    this.#window = undefined;
    if (window !== undefined && !window.isDestroyed()) {
      window.removeAllListeners();
      window.destroy();
    }
  }
}
