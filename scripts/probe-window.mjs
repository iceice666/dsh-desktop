/**
 * Minimal Electron navigation probe: no DSH host, just a window loading a
 * trivial local HTTP server. Isolates "Chromium cannot navigate in this
 * environment" from anything DSH-specific.
 *
 * Exits on its own with a hard deadline so it can never hang a session.
 *
 * Usage: electron scripts/probe-window.mjs
 */

import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';

const userData = process.env.DSH_DESKTOP_USER_DATA;
if (userData !== undefined) app.setPath('userData', userData);

const deadline = setTimeout(() => {
  console.log('probe-window: TIMED OUT before the page loaded');
  app.exit(3);
}, 30000);

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>probe</title><h1>probe ok</h1>');
});

await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${String(server.address().port)}/`;
console.log(`probe-window: serving ${url}`);

await app.whenReady();
console.log('probe-window: app ready');

const win = new BrowserWindow({ width: 600, height: 400, show: false });
win.webContents.on('did-fail-load', (_e, code, desc, target) => {
  console.log(`probe-window: did-fail-load ${String(code)} ${desc} ${target}`);
});

let status = 1;
try {
  await win.loadURL(url);
  const title = await win.webContents.executeJavaScript('document.title');
  console.log(`probe-window: LOADED OK, title = ${JSON.stringify(title)}`);
  status = 0;
} catch (error) {
  console.log(`probe-window: loadURL threw: ${String(error)}`);
}

clearTimeout(deadline);
server.close();
app.exit(status);
