/**
 * End-to-end check of Settings → rename → restart.
 *
 * Launches the app from the branded bundle, renames it through the page's own
 * requests (cookie + capability header, same as the Settings section), and
 * restarts. The relaunched instance runs in smoke mode and exits; this script
 * then confirms that:
 *
 * - the rebuilt bundle's Info.plist carries the new name;
 * - the relaunched process came up from that bundle and passed smoke;
 * - the old bundle is gone.
 *
 * Uses a throwaway userData, so the real app's saved name is untouched.
 *
 * Usage: node scripts/test-relaunch.mjs
 * (plus DSH_HOME / DSH_DESKTOP_ELECTRON_FLAGS as for `pnpm smoke` where needed)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUNDLE_DIRECTORY, ensureBrandedBundle } from '../src/main/branded-bundle.js';
import { PROJECT_ROOT } from '../src/main/branding.js';

const NEW_NAME = `Harness Relaunch ${String(process.pid)}`;
const userData = mkdtempSync(join(tmpdir(), 'dsh-relaunch-'));
const env = { ...process.env, DSH_DESKTOP_USER_DATA: userData, DSH_DESKTOP_VERBOSE: '1' };
delete env.DSH_DESKTOP_APP_NAME;

const extraFlags = (process.env.DSH_DESKTOP_ELECTRON_FLAGS ?? '').split(' ').filter(Boolean);

let failed = false;
/**
 * @param name - assertion label.
 * @param condition - result under test.
 */
function check(name, condition) {
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}`);
  if (!condition) failed = true;
}

try {
  const executable = ensureBrandedBundle({ env });
  const first = spawnSync(executable, [...extraFlags, PROJECT_ROOT], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...env, DSH_DESKTOP_TEST_RENAME: NEW_NAME },
    timeout: 120_000,
  });
  const firstOutput = `${first.stdout}${first.stderr}`;
  // The restart quits this instance, usually before the page's own promise
  // settles, so the proof of acceptance is the controller's log line.
  check(
    'first instance accepted the restart',
    firstOutput.includes('relaunching to apply branding'),
  );

  // The helper waits for the first process to exit, rebuilds, and starts the
  // relaunched instance in smoke mode; wait for that to report.
  const log = join(userData, 'relaunch.log');
  const deadline = Date.now() + 150_000;
  let text = '';
  while (Date.now() < deadline) {
    text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    if (text.includes('SMOKE OK') || text.includes('did not mount') || /Error/u.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(text.split('\n').filter((line) => /relaunch:|SMOKE|branding|Error/u.test(line)).join('\n'));

  const app = join(BUNDLE_DIRECTORY, `${NEW_NAME}.app`);
  check('bundle was rebuilt under the new name', existsSync(app));
  if (existsSync(app)) {
    const plist = join(app, 'Contents', 'Info.plist');
    const read = (key) => execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim();
    check('CFBundleName is the new name', read('CFBundleName') === NEW_NAME);
    check('CFBundleDisplayName is the new name', read('CFBundleDisplayName') === NEW_NAME);
  }
  check('old bundle was removed', !existsSync(join(BUNDLE_DIRECTORY, 'DeepSeek Harness.app')));
  check('relaunched instance started from the new bundle', text.includes(`relaunch: started ${app}`));
  check('relaunched instance passed smoke', text.includes('SMOKE OK'));
  check(
    'relaunched instance reports the new name without a pending restart',
    text.includes(`"name":"${NEW_NAME}","restartRequired":false`),
  );
} finally {
  rmSync(userData, { recursive: true, force: true });
  // Put the regular bundle back so `pnpm start` does not rebuild on its next run.
  ensureBrandedBundle();
}

if (failed) {
  console.error('\nrelaunch test FAILED');
  process.exit(1);
}
console.log('\nrelaunch test passed');
