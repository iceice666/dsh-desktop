/**
 * Keyboard shortcuts: the command table and the native application menu.
 *
 * Bindings follow the ChatGPT / Codex desktop apps (Settings › Keyboard
 * Shortcuts there), so muscle memory carries over: ⌘, opens Settings, ⌘N starts
 * a session, ⌘B toggles the sidebar, and so on.
 *
 * The accelerators live on the native menu, the way macOS apps expose them:
 * they appear in the menu bar, work wherever focus is inside the window, and
 * cannot be swallowed by a page handler. A page-level command is delivered to
 * the page as one DOM event (`dsh-desktop:command`) through
 * `webContents.executeJavaScript` — a one-way push from the main process. The
 * page gains no Electron API and no IPC channel; the `dsh-desktop-shortcuts`
 * client plugin listens for the event and runs the command through the
 * client's own services.
 *
 * This module has no Electron dependency so the table and the menu template
 * stay testable headlessly; `index.js` feeds the template to `Menu`.
 */

/** DOM event the page listens for; `detail` is the command id. */
export const COMMAND_EVENT = 'dsh-desktop:command';

/**
 * Page commands, in the order the Keyboard Shortcuts page lists them.
 *
 * `accelerators[0]` is the primary binding shown in the menu; the rest are
 * alternates registered on hidden items (on macOS a hidden item's accelerator
 * still fires). The same ids and accelerators are declared by the client
 * plugin; `scripts/test-shortcuts.mjs` keeps the two in step.
 */
export const PAGE_COMMANDS = Object.freeze([
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
].map((command) => Object.freeze({ ...command, accelerators: Object.freeze(command.accelerators) })));

const COMMAND_IDS = new Set(PAGE_COMMANDS.map((command) => command.id));

/**
 * @param id - candidate command id.
 * @returns whether `id` names a page command.
 */
export function isPageCommand(id) {
  return typeof id === 'string' && COMMAND_IDS.has(id);
}

/**
 * Script that delivers one command to the page.
 *
 * @param id - a page command id.
 * @returns JavaScript for `executeJavaScript`.
 * @throws when `id` is not a known command, so nothing else can be injected.
 */
export function commandScript(id) {
  if (!isPageCommand(id)) throw new Error(`dsh-desktop: unknown page command ${String(id)}`);
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(COMMAND_EVENT)}, { detail: ${JSON.stringify(id)} }));`;
}

const LABELS = {
  en: {
    settings: 'Settings…',
    shortcuts: 'Keyboard Shortcuts',
    toggleSidebar: 'Toggle Sidebar',
    toggleRightPanel: 'Toggle Right Panel',
    newSession: 'New Session',
    searchSessions: 'Search Sessions',
    previousSession: 'Previous Session',
    nextSession: 'Next Session',
    session: 'Session {n}',
    file: 'File',
    view: 'View',
    go: 'Go',
    help: 'Help',
  },
  zh: {
    settings: '设置…',
    shortcuts: '键盘快捷键',
    toggleSidebar: '切换侧边栏',
    toggleRightPanel: '切换右侧面板',
    newSession: '新会话',
    searchSessions: '搜索会话',
    previousSession: '上一个会话',
    nextSession: '下一个会话',
    session: '会话 {n}',
    file: '文件',
    view: '显示',
    go: '前往',
    help: '帮助',
  },
};

/**
 * @param locale - Electron `app.getLocale()` value.
 * @returns the menu dictionary for that locale.
 */
export function menuLabels(locale) {
  return String(locale ?? '').toLowerCase().startsWith('zh') ? LABELS.zh : LABELS.en;
}

/**
 * Build the application menu template.
 *
 * Standard roles (Edit, Window, zoom, full screen, quit) are kept: replacing
 * Electron's default menu without an Edit menu would silently break ⌘C/⌘V in
 * every text field on macOS.
 *
 * @param options - `{ platform, locale, appName, dispatch }`: the target
 *   platform, the UI locale, the display name, and `(id) => void` to deliver a
 *   page command.
 * @returns a template for `Menu.buildFromTemplate`.
 */
export function buildMenuTemplate(options) {
  const { platform, appName, dispatch } = options;
  const labels = menuLabels(options.locale);
  const mac = platform === 'darwin';
  const byId = new Map(PAGE_COMMANDS.map((command) => [command.id, command]));

  /**
   * One visible item plus a hidden item per alternate accelerator.
   * @param id - command id.
   * @param label - visible label.
   */
  const items = (id, label = labels[id]) => {
    const [primary, ...alternates] = byId.get(id).accelerators;
    const click = () => dispatch(id);
    return [
      { id: `dsh-desktop.${id}`, label, accelerator: primary, click },
      ...alternates.map((accelerator, index) => ({
        id: `dsh-desktop.${id}.alt${String(index + 1)}`,
        label,
        accelerator,
        click,
        visible: false,
        acceleratorWorksWhenHidden: true,
      })),
    ];
  };

  const sessionSlots = PAGE_COMMANDS
    .filter((command) => /^session\d$/u.test(command.id))
    .map((command) => ({
      id: `dsh-desktop.${command.id}`,
      label: labels.session.replace('{n}', command.id.slice('session'.length)),
      accelerator: command.accelerators[0],
      click: () => dispatch(command.id),
      // Nine near-identical rows would bury the menu; the Keyboard Shortcuts
      // page documents them instead.
      visible: false,
      acceleratorWorksWhenHidden: true,
    }));

  const template = [];

  if (mac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...items('settings'),
        ...items('shortcuts'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: labels.file,
    submenu: [
      ...items('newSession'),
      ...items('searchSessions'),
      { type: 'separator' },
      // Off macOS there is no app menu, so Settings lives here, as in the
      // Windows builds of ChatGPT and Codex.
      ...(mac ? [] : [...items('settings'), { type: 'separator' }]),
      mac ? { role: 'close' } : { role: 'quit' },
    ],
  });

  template.push({ role: 'editMenu' });

  template.push({
    label: labels.view,
    submenu: [
      ...items('toggleSidebar'),
      ...items('toggleRightPanel'),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      // `zoomIn` binds ⌘+ (⌘⇧= on US layouts); plain ⌘= is what people press.
      { role: 'zoomIn', accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
    ],
  });

  template.push({
    label: labels.go,
    submenu: [
      ...items('previousSession'),
      ...items('nextSession'),
      ...sessionSlots,
    ],
  });

  template.push({ role: 'windowMenu' });

  template.push({
    role: 'help',
    label: labels.help,
    // On macOS the bound item sits in the app menu; binding it twice would
    // make the accelerator ambiguous.
    submenu: mac
      ? [{ id: 'dsh-desktop.shortcuts.help', label: labels.shortcuts, click: () => dispatch('shortcuts') }]
      : items('shortcuts'),
  });

  return template;
}
