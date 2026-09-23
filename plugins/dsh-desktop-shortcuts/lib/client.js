window.__ModuleLoader__.load({
  id: 'dsh-desktop-shortcuts',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * Keyboard shortcuts: page-side command runner and the Settings page that
     * lists the bindings.
     *
     * The accelerators themselves live on the desktop app's native menu (see
     * `src/main/shortcuts.js`). When one fires, the main process dispatches a
     * `dsh-desktop:command` DOM event on `window`; this plugin maps the command
     * id onto the client's own services (`ctx.layout`, `ctx.uiWorkspace`,
     * `ctx.sidebarRight`) or, where upstream keeps the state component-local
     * (the Settings modal, the session search box), onto the control the user
     * would click. No Electron API is involved on this side.
     *
     * Handwritten lazy-CJS, like dsh-desktop-branding, so there is no build step.
     */

    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-desktop.shortcuts';
    const COMMAND_EVENT = 'dsh-desktop:command';
    const SECTION_ID = 'dsh-desktop-shortcuts';

    /**
     * Command table: id, group, and Electron accelerators. Must match
     * `PAGE_COMMANDS` in src/main/shortcuts.js (checked by
     * scripts/test-shortcuts.mjs).
     */
    const COMMANDS = [
      { id: 'settings', group: 'general', accelerators: ['CmdOrCtrl+,'] },
      { id: 'shortcuts', group: 'general', accelerators: ['CmdOrCtrl+/'] },
      { id: 'toggleSidebar', group: 'general', accelerators: ['CmdOrCtrl+B'] },
      { id: 'toggleRightPanel', group: 'general', accelerators: ['CmdOrCtrl+Alt+B'] },
      { id: 'newSession', group: 'sessions', accelerators: ['CmdOrCtrl+N', 'CmdOrCtrl+Shift+O'] },
      { id: 'searchSessions', group: 'sessions', accelerators: ['CmdOrCtrl+G'] },
      { id: 'previousSession', group: 'sessions', accelerators: ['CmdOrCtrl+Shift+['] },
      { id: 'nextSession', group: 'sessions', accelerators: ['CmdOrCtrl+Shift+]'] },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `session${String(index + 1)}`,
        group: 'sessions',
        accelerators: [`CmdOrCtrl+${String(index + 1)}`],
      })),
    ];

    /** Bindings built into the window (native menu roles), listed for reference. */
    const BUILTIN = [
      { id: 'zoomIn', group: 'view', accelerators: ['CmdOrCtrl+='] },
      { id: 'zoomOut', group: 'view', accelerators: ['CmdOrCtrl+-'] },
      { id: 'resetZoom', group: 'view', accelerators: ['CmdOrCtrl+0'] },
      { id: 'fullScreen', group: 'view', accelerators: ['Ctrl+Cmd+F'], macOnly: true },
      { id: 'closeWindow', group: 'window', accelerators: ['CmdOrCtrl+W'] },
      { id: 'minimize', group: 'window', accelerators: ['CmdOrCtrl+M'], macOnly: true },
      { id: 'quit', group: 'window', accelerators: ['CmdOrCtrl+Q'] },
    ];

    const zh = {
      nav: '键盘快捷键',
      title: '键盘快捷键',
      intro: '快捷键沿用 ChatGPT 与 Codex 桌面应用的习惯，在窗口任何位置都能使用，也列在菜单栏中。',
      unavailable: '快捷键仅在桌面应用中可用；以下为桌面应用中的按键。',
      'group.general': '通用',
      'group.sessions': '会话',
      'group.view': '显示',
      'group.window': '窗口',
      'command.settings': '打开设置',
      'command.shortcuts': '显示键盘快捷键',
      'command.toggleSidebar': '切换侧边栏',
      'command.toggleRightPanel': '切换右侧面板',
      'command.newSession': '新会话',
      'command.searchSessions': '搜索会话',
      'command.previousSession': '上一个会话',
      'command.nextSession': '下一个会话',
      'command.sessionN': '跳到第 1–9 个会话',
      'command.zoomIn': '放大',
      'command.zoomOut': '缩小',
      'command.resetZoom': '恢复实际大小',
      'command.fullScreen': '切换全屏',
      'command.closeWindow': '关闭窗口',
      'command.minimize': '最小化',
      'command.quit': '退出应用',
      or: '或',
    };

    const en = {
      nav: 'Keyboard shortcuts',
      title: 'Keyboard shortcuts',
      intro: 'Bindings follow the ChatGPT and Codex desktop apps. They work anywhere in the window and are also listed in the menu bar.',
      unavailable: 'Shortcuts are available in the desktop app only; these are the keys it uses.',
      'group.general': 'General',
      'group.sessions': 'Sessions',
      'group.view': 'View',
      'group.window': 'Window',
      'command.settings': 'Open settings',
      'command.shortcuts': 'Show keyboard shortcuts',
      'command.toggleSidebar': 'Toggle sidebar',
      'command.toggleRightPanel': 'Toggle right panel',
      'command.newSession': 'New session',
      'command.searchSessions': 'Search sessions',
      'command.previousSession': 'Previous session',
      'command.nextSession': 'Next session',
      'command.sessionN': 'Go to session 1–9',
      'command.zoomIn': 'Zoom in',
      'command.zoomOut': 'Zoom out',
      'command.resetZoom': 'Actual size',
      'command.fullScreen': 'Toggle full screen',
      'command.closeWindow': 'Close window',
      'command.minimize': 'Minimize',
      'command.quit': 'Quit',
      or: 'or',
    };

    const css = `
.dshDesktopShortcuts{width:100%;max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px}
.dshDesktopShortcuts h2{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dshDesktopShortcuts h3{margin:0 0 4px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dshDesktopShortcuts p{margin:0}
.dshDesktopShortcuts .intro{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshDesktopShortcuts .group{display:flex;flex-direction:column}
.dshDesktopShortcuts .row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:14px;line-height:22px}
.dshDesktopShortcuts .row:last-child{border-bottom:none}
.dshDesktopShortcuts .keys{display:inline-flex;align-items:center;gap:6px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshDesktopShortcuts kbd{display:inline-flex;align-items:center;gap:2px;min-width:20px;justify-content:center;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:500 12px/20px var(--ds-font-family-code, ui-monospace, monospace)}
`;

    /** Inject the page styles once, tagged like upstream plugin styles. */
    function installStyles() {
      const tagId = 'dsh-desktop-shortcuts/ShortcutsSection.css';
      const selector = `style[data-plugin-css=${JSON.stringify(tagId)}]`;
      if (document.querySelector(selector) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-desktop-shortcuts';
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /** Whether the page runs as the macOS desktop shell (or on a Mac at all). */
    function isMac() {
      if (document.documentElement.dataset.platform === 'darwin') return true;
      return /Mac/u.test(navigator.platform ?? '');
    }

    /** Whether the page is inside the desktop shell rather than a browser. */
    function isDesktop() {
      return /Electron\//u.test(navigator.userAgent ?? '');
    }

    const MAC_KEYS = { CmdOrCtrl: '⌘', Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
    const PC_KEYS = { CmdOrCtrl: 'Ctrl', Cmd: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

    /**
     * Render an Electron accelerator as the platform's key caps.
     * @param accelerator - e.g. `CmdOrCtrl+Shift+[`.
     * @param mac - whether to use macOS glyphs.
     * @returns key labels, in press order.
     */
    function keyCaps(accelerator, mac) {
      const table = mac ? MAC_KEYS : PC_KEYS;
      return accelerator.split(/\+(?!$)/u).map((part) => table[part] ?? part);
    }

    /** Wait one frame, so React can commit state set by a click. */
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    /**
     * Poll for an element for a short while.
     * @param find - returns the element or null.
     * @param frames - frames to wait at most.
     */
    async function waitFor(find, frames = 60) {
      for (let i = 0; i < frames; i += 1) {
        const found = find();
        if (found) return found;
        await nextFrame();
      }
      return null;
    }

    /**
     * First button whose accessible label is one of `labels`.
     * @param labels - accepted `aria-label` values.
     */
    function buttonLabelled(...labels) {
      return [...document.querySelectorAll('button[aria-label]')]
        .find((button) => labels.includes(button.getAttribute('aria-label'))) ?? null;
    }

    /** The open modal dialog, if any. */
    const openModal = () => document.querySelector('[role="dialog"][aria-modal="true"]');

    /**
     * Close an open modal the way the user would, with Escape; upstream modals
     * listen on `document`.
     */
    async function dismissModal() {
      if (openModal() === null) return;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await nextFrame();
    }

    /**
     * Session rows in sidebar order: tree items that carry `aria-selected`
     * (Workspace rows carry `aria-expanded` instead), minus ones inside a
     * collapsed or hidden branch.
     */
    function sessionRows() {
      return [...document.querySelectorAll('[role="tree"] [role="treeitem"][aria-selected]')]
        .filter((row) => !row.hasAttribute('aria-expanded') && row.getClientRects().length > 0);
    }

    /** Services the plugin needs before it can run anything. */
    const inject = ['slots', 'locale', 'layout', 'uiWorkspace'];

    /**
     * @param ctx - browser Cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-shortcuts: dictionaries');
      ctx.effect(() => installStyles(), 'dsh-desktop-shortcuts: styles');

      const t = ctx.locale.bind(NS);
      const tSettings = ctx.locale.bind('settings');
      const tSidebar = ctx.locale.bind('sidebar');
      const tWorkspace = ctx.locale.bind('workspace');

      /** Expand the left sidebar if it is collapsed to its rail. */
      async function ensureSidebarOpen() {
        if (buttonLabelled(tSidebar('toggle.open')) === null) return;
        ctx.layout.toggleSidebar();
        await nextFrame();
      }

      /** Open the Settings modal; resolves to the dialog, or null. */
      async function openSettings() {
        const existing = openModal();
        if (existing !== null && existing.querySelector('nav') !== null) return existing;
        await dismissModal();
        const trigger = buttonLabelled(tSettings('trigger'));
        if (trigger === null) return null;
        trigger.click();
        return waitFor(openModal);
      }

      /** Open Settings on the keyboard shortcuts page. */
      async function openShortcutsPage() {
        const dialog = await openSettings();
        if (dialog === null) return;
        const label = t('nav');
        const nav = await waitFor(() => [...dialog.querySelectorAll('nav button')]
          .find((button) => (button.textContent ?? '').trim() === label));
        nav?.click();
      }

      /** Open the sidebar's session search and focus its input. */
      async function searchSessions() {
        await dismissModal();
        await ensureSidebarOpen();
        const button = await waitFor(() => buttonLabelled(tWorkspace('search.sessions.aria')));
        if (button === null) return;
        button.click();
        await nextFrame();
        button.parentElement?.querySelector('input')?.focus();
      }

      /**
       * Select a session row relative to the current one, or by position.
       * @param pick - `(rows, currentIndex) => row | undefined`.
       */
      async function selectSession(pick) {
        await dismissModal();
        const rows = sessionRows();
        if (rows.length === 0) return;
        const current = rows.findIndex((row) => row.getAttribute('aria-selected') === 'true');
        const row = pick(rows, current);
        if (row === undefined) return;
        row.click();
        row.scrollIntoView({ block: 'nearest' });
      }

      const run = {
        settings: () => openSettings(),
        shortcuts: () => openShortcutsPage(),
        toggleSidebar: () => ctx.layout.toggleSidebar(),
        toggleRightPanel: () => ctx.get('sidebarRight')?.toggleExpanded(),
        newSession: async () => {
          await dismissModal();
          ctx.uiWorkspace.startSession();
        },
        searchSessions: () => searchSessions(),
        previousSession: () => selectSession((rows, i) => rows[i <= 0 ? rows.length - 1 : i - 1]),
        nextSession: () => selectSession((rows, i) => rows[i < 0 || i >= rows.length - 1 ? 0 : i + 1]),
      };
      for (let n = 1; n <= 9; n += 1) {
        // ⌘9 is "last", as in browsers and the ChatGPT app.
        run[`session${String(n)}`] = () => selectSession((rows) => (n === 9 ? rows.at(-1) : rows[n - 1]));
      }

      ctx.effect(() => {
        const onCommand = (event) => {
          const operation = Object.hasOwn(run, event.detail) ? run[event.detail] : undefined;
          if (operation === undefined) return;
          Promise.resolve()
            .then(operation)
            .catch((cause) => console.warn(`dsh-desktop-shortcuts: ${String(event.detail)} failed`, cause));
        };
        window.addEventListener(COMMAND_EVENT, onCommand);
        return () => window.removeEventListener(COMMAND_EVENT, onCommand);
      }, 'dsh-desktop-shortcuts: command listener');

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 91,
        label: () => t('nav'),
        locale: NS,
      }, ShortcutsSection));
    }

    /**
     * One row of the shortcuts table.
     * @param props - `{ label, accelerators, mac, t }`.
     */
    function ShortcutRow({ label, accelerators, mac, t }) {
      const keys = [];
      accelerators.forEach((accelerator, index) => {
        if (index > 0) keys.push(h('span', { key: `or${String(index)}` }, t('or')));
        keys.push(h('kbd', { key: accelerator }, keyCaps(accelerator, mac).join(mac ? '' : '+')));
      });
      return h('div', { className: 'row' }, h('span', null, label), h('span', { className: 'keys' }, keys));
    }

    /**
     * Settings page listing every binding.
     * @param props - slot props; `t` is the bound locale function.
     */
    function ShortcutsSection(props) {
      const t = props.t;
      const mac = isMac();
      const rows = [
        ...COMMANDS.filter((command) => !/^session\d$/u.test(command.id)),
        { id: 'sessionN', group: 'sessions', accelerators: ['CmdOrCtrl+1'], range: true },
        ...BUILTIN.filter((command) => mac || command.macOnly !== true),
      ];
      const groups = ['general', 'sessions', 'view', 'window'];
      return h('div', { className: 'dshDesktopShortcuts' },
        h('h2', null, t('title')),
        h('p', { className: 'intro' }, isDesktop() ? t('intro') : t('unavailable')),
        groups.map((group) => h('section', { key: group, className: 'group' },
          h('h3', null, t(`group.${group}`)),
          rows.filter((row) => row.group === group).map((row) => h(ShortcutRow, {
            key: row.id,
            label: t(`command.${row.id}`),
            accelerators: row.range ? ['CmdOrCtrl+1…9'] : row.accelerators,
            mac,
            t,
          })))));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.COMMANDS = COMMANDS;
    exports.ShortcutsSection = ShortcutsSection;
    return module.exports;
  },
});
