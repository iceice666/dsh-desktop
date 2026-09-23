/**
 * Launch the real app, verify the DSH client actually mounted, and exit.
 *
 * This is the only check that proves the whole chain end to end: host boot,
 * session admission, the capability header, page load, plugin bundle execution,
 * and React rendering. `scripts/check.mjs` verifies everything up to the window;
 * this verifies the window.
 *
 * Chromium needs a working sandbox and network service. Where a restricted
 * environment denies either, set `DSH_DESKTOP_ELECTRON_FLAGS` to work around it
 * — those flags are a property of that environment, never of the application:
 *
 *   DSH_DESKTOP_ELECTRON_FLAGS="--no-sandbox --disable-features=NetworkService,NetworkServiceInProcess"
 *
 * Usage: node scripts/smoke.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ensureBrandedBundle } from '../src/main/branded-bundle.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const extraFlags = (process.env.DSH_DESKTOP_ELECTRON_FLAGS ?? '')
  .split(' ')
  .filter((flag) => flag.length > 0);

// Launch through the branded bundle, exactly as `pnpm start` does, so the smoke
// also covers the bundle build.
const electron = ensureBrandedBundle();
const result = spawnSync(electron, [...extraFlags, root], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, DSH_DESKTOP_SMOKE: '1', DSH_DESKTOP_VERBOSE: '1' },
});

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
for (const line of output.split('\n')) {
  if (/dsh-desktop:|SMOKE|ERR_|did-fail/u.test(line)) console.log(line);
}

if (output.includes('SMOKE OK')) {
  console.log('\nsmoke passed — the client mounted in a real window');
  process.exit(0);
}
console.error('\nsmoke FAILED — see the lines above');
process.exit(1);
