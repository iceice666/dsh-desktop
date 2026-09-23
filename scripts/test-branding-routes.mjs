/**
 * Headless tests for the branding route admission policy and the saved
 * preferences, against a real loopback HTTP server.
 *
 * The controller is a recording stub: this verifies who may reach the
 * operations, not what they do in Electron (`pnpm smoke` covers that).
 *
 * Usage: node scripts/test-branding-routes.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRendererAccessHeader } from '../src/main/browser-access.js';
import { BRANDING_PATHS, createBrandingRoutes } from '../src/main/branding-routes.js';
import { BrandingPreferences, resolveBranding } from '../src/main/branding.js';

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

// ── routes ────────────────────────────────────────────────────────────────

const calls = [];
const controller = {
  state: () => { calls.push('state'); return { name: 'X' }; },
  setName: (name) => { calls.push(`setName:${String(name)}`); return { name: name ?? 'default' }; },
  chooseIcon: () => { calls.push('chooseIcon'); return { name: 'X' }; },
  resetIcon: () => { calls.push('resetIcon'); return { name: 'X' }; },
  iconPng: () => Buffer.from([0x89, 0x50]),
  restart: () => { calls.push('restart'); },
};

let header = createRendererAccessHeader();
let cookieValid = true;
const server = createServer();
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${String(server.address().port)}`;

const routes = new Map(
  createBrandingRoutes({
    origin,
    accessHeader: () => header,
    requestRejection: () => (cookieValid ? undefined : 401),
    controller,
  }).map(({ path, handler }) => [path, handler]),
);
server.on('request', (req, res) => {
  const handler = routes.get(new URL(req.url, origin).pathname);
  if (handler === undefined) { res.statusCode = 404; res.end(); return; }
  void handler(req, res);
});

/**
 * @param path - route path.
 * @param init - fetch init; `capability: false` omits the header.
 * @returns the response.
 */
async function request(path, init = {}) {
  const { capability = true, ...rest } = init;
  const headers = { ...(rest.headers ?? {}) };
  if (capability && header !== undefined) headers[header.name] = header.value;
  return fetch(`${origin}${path}`, { ...rest, headers });
}

/**
 * A well-formed mutation from the window.
 * @param path - route path.
 * @param body - JSON body.
 * @param extra - header overrides.
 */
function post(path, body, extra = {}) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...extra },
    body: JSON.stringify(body),
  });
}

check('state is readable by the window', (await request(BRANDING_PATHS.state)).status === 200);
check('state without capability is refused', (await request(BRANDING_PATHS.state, { capability: false })).status === 403);
check('state with a wrong capability is refused', (await request(BRANDING_PATHS.state, {
  capability: false,
  headers: { [header.name]: createRendererAccessHeader().value },
})).status === 403);

cookieValid = false;
check('a request failing the Connection fence is refused', (await request(BRANDING_PATHS.state)).status === 401);
cookieValid = true;

const saved = header;
header = undefined;
check('no live window means no access', (await request(BRANDING_PATHS.state, { capability: false, headers: { [saved.name]: saved.value } })).status === 503);
header = saved;

check('POST to a GET route is refused', (await post(BRANDING_PATHS.state, {})).status === 405);
check('GET to a POST route is refused', (await request(BRANDING_PATHS.name)).status === 405);

calls.length = 0;
check('setName accepts a well-formed request', (await post(BRANDING_PATHS.name, { name: 'Mine' })).status === 200);
check('setName reached the controller', calls.includes('setName:Mine'));
check('setName null clears the name', (await post(BRANDING_PATHS.name, { name: null })).status === 200 && calls.includes('setName:undefined'));

calls.length = 0;
check('mutation without Origin is refused', (await request(BRANDING_PATHS.name, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"a"}',
})).status === 403);
check('mutation from another Origin is refused', (await post(BRANDING_PATHS.name, { name: 'a' }, { origin: 'http://evil.example' })).status === 403);
check('cross-site fetch metadata is refused', (await post(BRANDING_PATHS.name, { name: 'a' }, { 'sec-fetch-site': 'cross-site' })).status === 403);
check('non-JSON content type is refused', (await post(BRANDING_PATHS.name, { name: 'a' }, { 'content-type': 'text/plain' })).status === 415);
check('extra body fields are refused', (await post(BRANDING_PATHS.name, { name: 'a', icon: '/etc/passwd' })).status === 400);
check('missing body fields are refused', (await post(BRANDING_PATHS.name, {})).status === 400);
check('a non-string name is refused', (await post(BRANDING_PATHS.name, { name: 3 })).status === 400);
check('an oversized body is refused', (await post(BRANDING_PATHS.name, { name: 'x'.repeat(8000) })).status === 413);
check('malformed JSON is refused', (await request(BRANDING_PATHS.name, {
  method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{',
})).status === 400);
check('no refused request reached the controller', calls.length === 0);

check('chooseIcon takes no parameters from the page', (await post(BRANDING_PATHS.chooseIcon, { path: '/tmp/x.png' })).status === 400);
check('chooseIcon with an empty body is accepted', (await post(BRANDING_PATHS.chooseIcon, {})).status === 200);
check('resetIcon is accepted', (await post(BRANDING_PATHS.resetIcon, {})).status === 200);

const icon = await request(BRANDING_PATHS.icon);
check('icon is served as PNG', icon.status === 200 && icon.headers.get('content-type') === 'image/png');

calls.length = 0;
const restart = await post(BRANDING_PATHS.restart, {});
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setTimeout(resolve, 20));
check('restart answers 202 before relaunching', restart.status === 202);
check('restart reached the controller', calls.includes('restart'));

server.close();

// ── preferences ──────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'dsh-branding-prefs-'));
try {
  const prefs = new BrandingPreferences(scratch);
  check('nothing saved reads as empty', Object.keys(prefs.read()).length === 0);

  prefs.setName('  Mine  ');
  check('saved name is trimmed and persisted', new BrandingPreferences(scratch).read().name === 'Mine');
  check('saved name wins over the default', resolveBranding({ env: {}, preferences: prefs.read() }).name === 'Mine');
  check('env name wins over the saved name', resolveBranding({ env: { DSH_DESKTOP_APP_NAME: 'Env' }, preferences: prefs.read() }).name === 'Env');
  check('name source is reported', resolveBranding({ env: {}, preferences: prefs.read() }).sources.name === 'preferences');
  prefs.setName(undefined);
  check('clearing the name falls back to the default', resolveBranding({ env: {}, preferences: prefs.read() }).name === 'DeepSeek Harness');

  let threw = false;
  try { prefs.setName('a/b'); } catch { threw = true; }
  check('an unsafe name is refused on save', threw);
  threw = false;
  try { prefs.setName('x'.repeat(65)); } catch { threw = true; }
  check('an over-long name is refused on save', threw);

  const png = join(scratch, 'source.png');
  writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
  const afterIcon = prefs.setIcon(png);
  check('an adopted icon is copied into userData', afterIcon.icon !== png && afterIcon.icon.startsWith(join(scratch, 'branding')) && existsSync(afterIcon.icon));
  rmSync(png);
  check('the copy survives removal of the original', prefs.read().icon === afterIcon.icon);
  const resolved = resolveBranding({ env: {}, preferences: prefs.read() });
  check('saved icon wins over the default', resolved.iconPng === afterIcon.icon && resolved.sources.icon === 'preferences');

  const fake = join(scratch, 'fake.png');
  writeFileSync(fake, 'not a png');
  threw = false;
  try { prefs.setIcon(fake); } catch { threw = true; }
  check('a file with the wrong signature is refused', threw);
  const svg = join(scratch, 'x.svg');
  writeFileSync(svg, '<svg/>');
  threw = false;
  try { prefs.setIcon(svg); } catch { threw = true; }
  check('an unsupported type is refused', threw);
  check('a refused icon leaves the saved one in place', prefs.read().icon === afterIcon.icon);

  prefs.setIcon(undefined);
  check('resetting the icon removes the choice', prefs.read().icon === undefined);
  check('resetting the icon prunes the copy', !existsSync(afterIcon.icon));

  writeFileSync(prefs.path, '{ not json');
  check('a corrupt preferences file degrades to nothing saved', Object.keys(prefs.read()).length === 0);
  writeFileSync(prefs.path, JSON.stringify({ name: 'a:b', icon: '/nonexistent/x.png' }));
  check('invalid saved values are ignored individually', Object.keys(prefs.read()).length === 0);
  writeFileSync(prefs.path, JSON.stringify({ name: 'Kept', icon: 'relative.png' }));
  check('a relative saved icon path is ignored', prefs.read().icon === undefined && prefs.read().name === 'Kept');
  check('writes are valid JSON', JSON.parse(readFileSync(prefs.path, 'utf8')).name === 'Kept');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAILED ${String(failures.length)} of ${String(passed + failures.length)}:`);
  for (const name of failures) console.error(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`ok — ${String(passed)} assertions passed`);
