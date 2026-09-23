/**
 * Mark the document as the macOS desktop shell.
 *
 * The upstream client already ships the hidden-inset titlebar layout — native
 * drag regions (`-webkit-app-region: drag`) over the header rows, no-drag
 * carve-outs for their controls, and room for the traffic lights — but gates
 * all of it on `<html data-platform="darwin">`, which it expects the Electron
 * preload to set (see `isDarwinDesktop` in dsh-client-ui-primitives). Plain web
 * never sets it.
 *
 * This preload sets that one attribute and nothing else: no `contextBridge`,
 * no IPC, no Electron API reaches the page, so the renderer stays under the
 * strict sandbox. Double-click on a drag region is then handled natively by
 * Electron, following the user's "double-click a window's title bar to…"
 * system setting, exactly like a native title bar.
 *
 * CommonJS because sandboxed preloads cannot be ES modules.
 */

'use strict';

if (process.platform === 'darwin') {
  const mark = () => {
    const root = document.documentElement;
    if (root === null) return false;
    root.dataset.platform = 'darwin';
    return true;
  };

  // The preload can run before `<html>` exists. Mark as early as possible so
  // the client's first render already picks the macOS layout; fall back to the
  // first moment the element appears.
  if (!mark()) {
    const observer = new MutationObserver(() => {
      if (mark()) observer.disconnect();
    });
    observer.observe(document, { childList: true });
    window.addEventListener('DOMContentLoaded', () => {
      observer.disconnect();
      mark();
    }, { once: true });
  }
}
