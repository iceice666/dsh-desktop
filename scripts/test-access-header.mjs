/**
 * Headless tests for the renderer capability and the header-attachment policy.
 *
 * These are the security-critical decisions of the shell, and they are pure
 * functions of their inputs, so they are verified without launching Chromium.
 * `installRendererAccessHeader` is driven through a fake `webContents` whose
 * session records the registered listener.
 *
 * Usage: node scripts/test-access-header.mjs
 */

import { createRendererAccessHeader, sameAccessToken } from '../src/main/browser-access.js';
import { installRendererAccessHeader } from '../src/main/renderer-session.js';

let passed = 0;
const failures = [];

/**
 * @param name - assertion label.
 * @param condition - result under test.
 */
function check(name, condition) {
  if (condition === true) {
    passed += 1;
    return;
  }
  failures.push(name);
}

// ── capability minting ────────────────────────────────────────────────────

const header = createRendererAccessHeader();
check('header name is the desktop renderer header', header.name === 'x-dsh-desktop-renderer');
check('token is 43 base64url chars', /^[A-Za-z0-9_-]{43}$/u.test(header.value));
check('header object is frozen', Object.isFrozen(header));

const other = createRendererAccessHeader();
check('tokens differ per generation', header.value !== other.value);

// ── constant-time comparison ──────────────────────────────────────────────

check('matching token accepted', sameAccessToken(header.value, header.value));
check('different token rejected', !sameAccessToken(other.value, header.value));
check('undefined rejected', !sameAccessToken(undefined, header.value));
check('empty string rejected', !sameAccessToken('', header.value));
check('wrong-shape token rejected', !sameAccessToken('short', header.value));
check(
  'same-length non-base64url rejected',
  !sameAccessToken('!'.repeat(43), header.value),
);

// ── header attachment policy ──────────────────────────────────────────────

const ORIGIN = 'http://127.0.0.1:61530';
const RENDERER_ID = 7;

/**
 * Drive the installed listener once and return the resulting headers.
 * @param details - partial `onBeforeSendHeaders` details.
 * @returns the headers the listener produced.
 */
function runListener(details) {
  let registered;
  const webContents = {
    id: RENDERER_ID,
    session: {
      webRequest: {
        onBeforeSendHeaders(filterOrNull, listener) {
          if (filterOrNull !== null) registered = listener;
        },
      },
    },
  };
  const dispose = installRendererAccessHeader(webContents, ORIGIN, header);
  let output;
  registered(
    { requestHeaders: {}, ...details },
    (response) => {
      output = response.requestHeaders;
    },
  );
  dispose();
  return output;
}

/** A frame object on the carrier origin. */
const carrierFrame = { detached: false, origin: ORIGIN, parent: null };
Object.assign(carrierFrame, { top: carrierFrame });

const mainFrame = runListener({
  url: `${ORIGIN}/`,
  resourceType: 'mainFrame',
  webContentsId: RENDERER_ID,
});
check('main frame on carrier gets the header', mainFrame[header.name] === header.value);

const subresource = runListener({
  url: `${ORIGIN}/plugins/x/client.js`,
  resourceType: 'script',
  webContentsId: RENDERER_ID,
  frame: carrierFrame,
});
check('same-origin subresource gets the header', subresource[header.name] === header.value);

const websocket = runListener({
  url: `ws://127.0.0.1:61530/api/remote.mux`,
  resourceType: 'websocket',
  webContentsId: RENDERER_ID,
  frame: carrierFrame,
});
check('paired websocket origin gets the header', websocket[header.name] === header.value);

const crossOrigin = runListener({
  url: 'https://example.com/asset.js',
  resourceType: 'script',
  webContentsId: RENDERER_ID,
  frame: carrierFrame,
});
check('cross-origin request is not marked', crossOrigin[header.name] === undefined);

const otherRenderer = runListener({
  url: `${ORIGIN}/api/x`,
  resourceType: 'xhr',
  webContentsId: RENDERER_ID + 1,
  frame: carrierFrame,
});
check('another webContents is not marked', otherRenderer[header.name] === undefined);

const foreignFrame = runListener({
  url: `${ORIGIN}/api/x`,
  resourceType: 'xhr',
  webContentsId: RENDERER_ID,
  frame: { detached: false, origin: 'https://evil.test', parent: null, top: undefined },
});
check('request from a foreign frame is not marked', foreignFrame[header.name] === undefined);

const detachedFrame = runListener({
  url: `${ORIGIN}/api/x`,
  resourceType: 'xhr',
  webContentsId: RENDERER_ID,
  frame: { detached: true, origin: ORIGIN, parent: null, top: undefined },
});
check('request from a detached frame is not marked', detachedFrame[header.name] === undefined);

const spoofed = runListener({
  url: 'https://example.com/asset.js',
  resourceType: 'script',
  webContentsId: RENDERER_ID,
  frame: carrierFrame,
  requestHeaders: { 'X-DSH-Desktop-Renderer': 'spoofed-value' },
});
check(
  'page-supplied header is stripped on a cross-origin request',
  spoofed[header.name] === undefined && spoofed['X-DSH-Desktop-Renderer'] === undefined,
);

const spoofedSameOrigin = runListener({
  url: `${ORIGIN}/api/x`,
  resourceType: 'xhr',
  webContentsId: RENDERER_ID,
  frame: carrierFrame,
  requestHeaders: { 'X-DSH-Desktop-Renderer': 'spoofed-value' },
});
check(
  'page-supplied header is replaced by the real capability',
  spoofedSameOrigin[header.name] === header.value &&
    spoofedSameOrigin['X-DSH-Desktop-Renderer'] === undefined,
);

// ── report ────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`FAILED ${String(failures.length)} of ${String(passed + failures.length)}:`);
  for (const name of failures) console.error(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`ok — ${String(passed)} assertions passed`);
