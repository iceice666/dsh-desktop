/**
 * Headless tests for application identity resolution.
 *
 * Usage: node scripts/test-branding.mjs
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROJECT_ROOT, resolveBranding as resolveWith } from '../src/main/branding.js';

/**
 * Resolve with the given environment and no saved preferences, so the tests
 * never depend on what the real userData holds.
 * @param env - environment overrides.
 * @param root - project root.
 */
function resolveBranding(env, root) {
  return resolveWith({ env, preferences: {}, ...(root === undefined ? {} : { root }) });
}

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

/**
 * @param fn - function expected to throw.
 * @returns whether it threw.
 */
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ── defaults from this repository ─────────────────────────────────────────

const defaults = resolveBranding({});
check('default name is the productName', defaults.name === 'DeepSeek Harness');
check('default bundle id comes from package.json', defaults.bundleId === 'dev.dsh-desktop');
check('default PNG icon ships in assets/', defaults.iconPng === join(PROJECT_ROOT, 'assets', 'icon.png'));
check('default icns ships in assets/', defaults.iconIcns === join(PROJECT_ROOT, 'assets', 'icon.icns'));

// ── overrides ─────────────────────────────────────────────────────────────

check('name override wins', resolveBranding({ DSH_DESKTOP_APP_NAME: 'My Harness' }).name === 'My Harness');
check('name is trimmed', resolveBranding({ DSH_DESKTOP_APP_NAME: '  X  ' }).name === 'X');
check('empty name is rejected', throws(() => resolveBranding({ DSH_DESKTOP_APP_NAME: '  ' })));
check('slash in name is rejected', throws(() => resolveBranding({ DSH_DESKTOP_APP_NAME: 'a/b' })));
check('colon in name is rejected', throws(() => resolveBranding({ DSH_DESKTOP_APP_NAME: 'a:b' })));
check('bundle id override wins', resolveBranding({ DSH_DESKTOP_BUNDLE_ID: 'com.example.x' }).bundleId === 'com.example.x');
check('malformed bundle id is rejected', throws(() => resolveBranding({ DSH_DESKTOP_BUNDLE_ID: 'a b' })));

const scratch = mkdtempSync(join(tmpdir(), 'dsh-branding-'));
try {
  const png = join(scratch, 'custom.png');
  const icns = join(scratch, 'custom.icns');
  const svg = join(scratch, 'custom.svg');
  for (const path of [png, icns, svg]) writeFileSync(path, '');

  const fromPng = resolveBranding({ DSH_DESKTOP_ICON: png });
  check('PNG override replaces both icons', fromPng.iconPng === png && fromPng.iconIcns === undefined);
  const fromIcns = resolveBranding({ DSH_DESKTOP_ICON: icns });
  check('icns override replaces both icons', fromIcns.iconIcns === icns && fromIcns.iconPng === undefined);
  check('relative icon resolves against the root', resolveBranding({ DSH_DESKTOP_ICON: 'assets/icon.png' }).iconPng === join(PROJECT_ROOT, 'assets', 'icon.png'));
  check('unsupported icon type is rejected', throws(() => resolveBranding({ DSH_DESKTOP_ICON: svg })));
  check('missing icon is rejected, not ignored', throws(() => resolveBranding({ DSH_DESKTOP_ICON: join(scratch, 'nope.png') })));

  // A root without package.json or assets falls back to built-in defaults.
  const bare = resolveBranding({}, scratch);
  check('bare root falls back to the default name', bare.name === 'DeepSeek Harness');
  check('bare root has no icon', bare.iconPng === undefined && bare.iconIcns === undefined);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAILED ${String(failures.length)} of ${String(passed + failures.length)}:`);
  for (const name of failures) console.error(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`ok — ${String(passed)} assertions passed`);
