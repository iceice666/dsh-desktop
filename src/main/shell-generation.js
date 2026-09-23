/**
 * One desktop shell generation: the window, its listeners, and the renderer
 * capability, owned together and released together.
 *
 * A profile or mode switch disposes the whole generation and starts a new one.
 * Nothing here may be cached across generations — a stale `BrowserWindow` or a
 * stale header disposer would attach this generation's capability to the next
 * generation's traffic.
 */

import { BrowserWindow, shell } from 'electron';

import { createRendererAccessHeader } from './browser-access.js';
import { blocksNavigation, externalPopupTarget } from './navigation-policy.js';
import {
  authenticateRendererSession,
  installRendererAccessHeader,
} from './renderer-session.js';

/** Persistent partition isolated from the default and any auxiliary session. */
export const RENDERER_SESSION_PARTITION = 'persist:dsh-desktop-renderer';

export class ShellGeneration {
  #window;
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
        // plugin system, so the strict sandbox stays on.
        sandbox: true,
        webSecurity: true,
        partition: RENDERER_SESSION_PARTITION,
      },
    });
    this.#window = window;

    const renderer = window.webContents;

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
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`dsh-desktop: the client did not mount in time; last saw ${lastSeen}`);
  }

  /** Whether the window is still usable. */
  get alive() {
    return this.#window !== undefined && !this.#window.isDestroyed();
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

    const window = this.#window;
    this.#window = undefined;
    if (window !== undefined && !window.isDestroyed()) {
      window.removeAllListeners();
      window.destroy();
    }
  }
}
