/**
 * Pure-logic checks for the packaged app: layout detection, harness choice,
 * the Node shim, login-shell capture parsing, and the icon
 * identity that decides whether a relaunch is needed. No window, no bundle.
 *
 * Usage: node scripts/test-packaging.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { iconIdentity } from '../src/main/branding.js';
import { findHarnessAnchor } from '../src/main/find-harness.js';
import { installNodeShim, overlayYaml, shellQuote, shimScript } from '../src/main/node-shim.js';
import {
  bundleManager,
  bundledHarnessAnchor,
  isPackagedLayout,
  packagedAppBundle,
} from '../src/main/packaged.js';
import { parseCapture, selectUpdates } from '../src/main/shell-environment.js';

let passed = 0;
const failures = [];

/**
 * @param name - assertion label.
 * @param condition - result under test.
 */
function check(name, condition) {
  if (condition === true) passed += 1;
  else failures.push(name);
}

/**
 * @param fn - function expected to throw.
 * @param pattern - message pattern.
 * @returns whether it threw a matching error.
 */
function throws(fn, pattern) {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(String(error?.message));
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-desktop-packaging-'));
try {
  // ── layout ────────────────────────────────────────────────────────────────
  const root = join(scratch, 'Some Name.app', 'Contents', 'Resources', 'app');
  check('layout: packaged root is detected', isPackagedLayout(root));
  check('layout: the checkout is not packaged', !isPackagedLayout());
  check('layout: a folder named app elsewhere is not packaged', !isPackagedLayout(join(scratch, 'Resources', 'app')));
  check('layout: bundle path is the enclosing .app', packagedAppBundle(root) === join(scratch, 'Some Name.app'));

  // ── harness choice ────────────────────────────────────────────────────────
  mkdirSync(root, { recursive: true });
  check('harness: no bundled anchor without the runtime', bundledHarnessAnchor(root) === undefined);
  check(
    'harness: a packaged app with no bundled harness fails instead of using PATH',
    throws(() => findHarnessAnchor({ root }), /bundled DSH harness is missing/u),
  );
  const fakeDsh = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(fakeDsh, { recursive: true });
  writeFileSync(join(fakeDsh, 'package.json'), '{"name":"@deepseek-ai/dsh"}');
  check('harness: bundled anchor found once present', bundledHarnessAnchor(root) === join(root, 'runtime', 'node_modules'));
  check(
    'harness: an incomplete bundled harness is still refused',
    throws(() => findHarnessAnchor({ root }), /missing or incomplete/u),
  );

  check('managed: the checkout is never managed', bundleManager() === undefined);

  // ── node shim ─────────────────────────────────────────────────────────────
  check('shim: quoting survives a single quote', shellQuote("a'b") === `'a'\\''b'`);
  const awkward = "/Apps/It's Mine.app/Contents/MacOS/Electron";
  const script = shimScript(awkward);
  check('shim: sets RunAsNode only for the exec', script.includes(`ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(awkward)} "$@"`));
  check('shim: overlay targets the ptc-runtime row', /- id: ptc-runtime\n {2}config:\n {4}nodeExecutable: "/u.test(overlayYaml('/s/node')));

  const { shim, overlay } = installNodeShim({ userData: scratch, executable: '/bin/echo' });
  // With /bin/echo standing in for Electron, the shim must pass every argument
  // through unchanged, spaces included.
  const echoed = execFileSync(shim, ['one', 'two words'], { encoding: 'utf8' });
  check('shim: forwards arguments verbatim', echoed === 'one two words\n');
  check('shim: overlay points at the written shim', readFileSync(overlay, 'utf8').includes(JSON.stringify(shim)));
  const env = execFileSync(installNodeShim({ userData: join(scratch, 'env'), executable: '/usr/bin/env' }).shim, [], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  check('shim: child sees ELECTRON_RUN_AS_NODE=1', env.split('\n').includes('ELECTRON_RUN_AS_NODE=1'));

  // ── login-shell capture ───────────────────────────────────────────────────
  const payload = Buffer.from('rc noise\nS\0PATH=/opt/bin:/usr/bin\0GOPATH=/go\0SECRET_TOKEN=x\0LC_ALL=C\0E\0trailing');
  const captured = parseCapture(payload, 'S', 'E');
  check('capture: parses records between markers', captured.PATH === '/opt/bin:/usr/bin' && captured.GOPATH === '/go');
  check('capture: missing end marker is an error', throws(() => parseCapture(Buffer.from('S\0A=1\0'), 'S', 'E'), /end marker/u));
  const updates = selectUpdates(captured, { GOPATH: '/mine', PATH: '/usr/bin' });
  check('capture: PATH replaces the inherited value', updates.PATH === '/opt/bin:/usr/bin');
  check('capture: an inherited toolchain variable is kept', updates.GOPATH === undefined);
  check('capture: unlisted variables are not adopted', updates.SECRET_TOKEN === undefined);
  check('capture: LC_* is adopted', updates.LC_ALL === 'C');

  // ── icon identity ─────────────────────────────────────────────────────────
  check(
    'icon: the shipped default is path-independent',
    iconIdentity({ iconIcns: '/build/machine/icon.icns', sources: { icon: 'default' } }) === 'default',
  );
  check('icon: no icon at all', iconIdentity({ sources: { icon: 'default' } }) === 'none');
  check(
    'icon: a saved icon is identified by its file',
    iconIdentity({ iconPng: '/ud/branding/icon-ab.png', sources: { icon: 'preferences' } }) === '/ud/branding/icon-ab.png',
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAILED (${String(failures.length)}):\n${failures.map((name) => `  - ${name}`).join('\n')}`);
  process.exit(1);
}
console.log(`ok — ${String(passed)} assertions passed`);
