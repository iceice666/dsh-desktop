/**
 * macOS titlebar behaviour for the hidden-inset window.
 *
 * `titleBarStyle: 'hiddenInset'` removes the native titlebar, so the window
 * can only be moved (and zoomed by double-click) through regions the page
 * declares with `-webkit-app-region: drag`. Upstream declares some — the
 * sidebar's top strip and the open conversation's title row — but none on the
 * empty home view, Settings, or a collapsed sidebar, which leaves the top edge
 * of the window inert there.
 *
 * This stylesheet adds one fixed drag strip across the top edge, the height of
 * a native titlebar. Chromium resolves app regions in document order, so the
 * strip (the first box in `<body>`) is carved back out by every later
 * `no-drag` declaration: upstream's own header controls plus the interactive
 * elements listed below, which stay clickable where they overlap it. The strip
 * itself has no pointer events, so it never swallows a click outside the drag
 * area either.
 *
 * Double-click on any drag region is handled natively by Electron and follows
 * the user's System Settings choice ("Double-click a window's title bar to
 * zoom / minimize / do nothing").
 *
 * Injected from the main process with `webContents.insertCSS`, so the page
 * still receives no Electron API.
 */

/** Height of the drag strip, matching a native hidden-inset titlebar. */
export const TITLEBAR_DRAG_HEIGHT = 38;

/** Elements that must stay interactive where they overlap a drag region. */
const INTERACTIVE = [
  'button',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  'a',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="dialog"]',
  '[aria-modal="true"]',
];

/** Stylesheet injected into every main-frame document on macOS. */
export const MAC_TITLEBAR_CSS = [
  `html[data-platform="darwin"] body::before { content: ""; position: fixed; z-index: 2147483647; top: 0; left: 0; right: 0; height: ${String(TITLEBAR_DRAG_HEIGHT)}px; pointer-events: none; -webkit-app-region: drag; }`,
  // A modal owns the whole window: its backdrop must stay clickable to dismiss.
  'html[data-platform="darwin"]:has([aria-modal="true"]) body::before { -webkit-app-region: no-drag; }',
  `html[data-platform="darwin"] :is(${INTERACTIVE.join(', ')}) { -webkit-app-region: no-drag; }`,
].join('\n');

/**
 * Keep the titlebar stylesheet applied to the window's documents.
 *
 * `insertCSS` lasts for one document, so it is reapplied on every main-frame
 * load. A no-op off macOS.
 *
 * @param renderer - the window's `webContents`.
 * @param log - diagnostics sink.
 */
export function installMacTitlebar(renderer, log) {
  if (process.platform !== 'darwin') return;
  renderer.on('dom-ready', () => {
    renderer.insertCSS(MAC_TITLEBAR_CSS).catch((cause) => {
      log(`failed to install titlebar styles: ${String(cause)}`);
    });
  });
}
