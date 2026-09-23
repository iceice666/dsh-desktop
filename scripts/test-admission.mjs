/**
 * End-to-end check of the two-stage session admission against a real host,
 * without Chromium.
 *
 * `session.fetch` in Electron is a credentialed fetch bound to a cookie store.
 * This script reproduces that shape with a minimal cookie jar so the admission
 * contract can be verified headlessly:
 *
 *   1. clean `GET /` is refused (401) — the window cannot load the bare origin;
 *   2. `GET` on the tokenized URL succeeds and returns a session cookie;
 *   3. clean `GET /` with that cookie now succeeds — the URL the window loads;
 *   4. the tokenized URL never appears in what the window navigates to.
 *
 * Usage: node scripts/test-admission.mjs
 */

import { startHost, resolveOrigin, resolveAuthenticationUrl } from '../src/main/host.js';
import { createRendererAccessHeader } from '../src/main/browser-access.js';
import { findHarnessAnchor } from '../src/main/find-harness.js';

const { anchor } = findHarnessAnchor();

let passed = 0;
const failures = [];

/**
 * @param name - assertion label.
 * @param condition - result under test.
 */
function check(name, condition) {
  if (condition === true) {
    passed += 1;
    console.log(`  ok  ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name}`);
}

const host = await startHost({
  profile: process.env.DSH_DESKTOP_PROFILE ?? 'web',
  anchor,
  port: 0,
  log: () => {},
});

try {
  const origin = resolveOrigin(host.ctx);
  const authenticationUrl = resolveAuthenticationUrl(host.ctx, origin);
  const accessHeader = createRendererAccessHeader();
  console.log(`origin = ${origin}`);

  check('origin is loopback', new URL(origin).hostname === '127.0.0.1');
  check(
    'authentication URL carries a token on the same origin',
    new URL(authenticationUrl).origin === origin &&
      new URL(authenticationUrl).searchParams.has('token'),
  );

  // Stage 0: the bare origin is refused, which is why the exchange is needed.
  const bare = await fetch(origin, { redirect: 'manual' });
  check('clean GET / is refused before admission', bare.status === 401);
  await bare.body?.cancel();

  // Stage 1: the exchange, as `authenticateRendererSession` performs it.
  //
  // Electron's `session.fetch` follows the redirect with its cookie jar
  // attached, so it observes a final 200. Plain `fetch` has no jar: following
  // the 303 here would re-request clean `/` uncredentialed and see 401. The
  // redirect is therefore captured manually and replayed with the cookie, which
  // is exactly what the jar does.
  const admitted = await fetch(authenticationUrl, {
    method: 'GET',
    redirect: 'manual',
    cache: 'no-store',
    headers: { [accessHeader.name]: accessHeader.value },
  });
  check('tokenized GET mints a session and redirects', admitted.status === 303);
  check('redirect target is clean /', admitted.headers.get('location') === '/');
  check(
    'mint response is not cacheable',
    admitted.headers.get('cache-control') === 'no-store',
  );
  check(
    'token is not leaked through the referrer',
    admitted.headers.get('referrer-policy') === 'no-referrer',
  );

  const setCookie = admitted.headers.getSetCookie?.() ?? [];
  check('exchange returns a session cookie', setCookie.length > 0);
  check(
    'cookie is HttpOnly and SameSite=Strict',
    setCookie.some(
      (c) => /httponly/iu.test(c) && /samesite=strict/iu.test(c),
    ),
  );
  await admitted.body?.cancel();

  const cookie = setCookie.map((entry) => entry.split(';', 1)[0]).join('; ');

  // Stage 2: the clean navigation the window actually performs.
  const loaded = await fetch(origin, {
    redirect: 'manual',
    headers: { cookie, [accessHeader.name]: accessHeader.value },
  });
  check('clean GET / succeeds once the cookie is held', loaded.status === 200);

  const html = loaded.status === 200 ? await loaded.text() : '';
  check('served index is an HTML document', /<!doctype html/iu.test(html));
  check(
    'index carries the client boot payload',
    html.includes('__DSH_BOOT__'),
  );
  check(
    'server-rendered index needs no desktop boot shim',
    !html.includes('dshDesktopBoot'),
  );
  check(
    'launch token never appears in the navigated document',
    !html.includes(new URL(authenticationUrl).searchParams.get('token')),
  );
} finally {
  await host.dispose();
}

if (failures.length > 0) {
  console.error(`\nFAILED ${String(failures.length)} of ${String(passed + failures.length)}`);
  process.exit(1);
}
console.log(`\nok — ${String(passed)} assertions passed`);
process.exit(0);
