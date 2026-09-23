/**
 * Relaunch the app so a name change reaches the menu bar and Cmd-Tab.
 *
 * `app.relaunch()` is not enough: it re-executes the *current* bundle, whose
 * Info.plist still carries the old name, and the bundle cannot be rebuilt
 * while the app is running from it — Chromium launches its helper apps from
 * inside the bundle for as long as it lives.
 *
 * Instead a small detached helper is left behind. It waits for this process to
 * exit, rebuilds the branded bundle with the new preferences, and starts the
 * app again from it. The helper runs under Electron's own Node
 * (`ELECTRON_RUN_AS_NODE`), so no separate Node installation is needed.
 *
 * A packaged app (scripts/package.mjs) has no dev bundle to rebuild. There
 * the helper stamps the installed bundle itself — Info.plist, icon, and the
 * `.app` directory name when the parent directory allows it — and re-signs it
 * ad hoc, because editing Info.plist breaks the bundle's seal.
 *
 * Usage (as the helper): ELECTRON_RUN_AS_NODE=1 <electron> relaunch.js <mode> <pid> [electron args...]
 * where <mode> is `dev` or `packaged`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_ROOT, resolveBranding, userDataDirectory } from './branding.js';
// Static, not lazy: in packaged mode the helper may rename the very bundle it
// was loaded from, after which a dynamic import from the old path would fail.
import { ensureBrandedBundle, stampBundle } from './branded-bundle.js';
import { packagedAppBundle } from './packaged.js';

/** How long the helper waits for the old process before giving up. */
const EXIT_TIMEOUT_MS = 60_000;

/**
 * Start the detached helper. The caller must quit right after.
 *
 * @param options - `{ executable, args, env, packaged }`: the Electron
 *   executable to run the helper with, the arguments the new instance should
 *   receive (without the app directory), the environment to launch it with,
 *   and whether this is a packaged app.
 */
export function scheduleRelaunch(options) {
  const env = { ...options.env };
  // Test switches never carry over into the relaunched app — except that a
  // rename exercise asks for the new instance to verify itself and exit.
  const verifyAfter = env.DSH_DESKTOP_TEST_RENAME !== undefined;
  delete env.DSH_DESKTOP_SMOKE;
  delete env.DSH_DESKTOP_TEST_RENAME;
  if (verifyAfter) env.DSH_DESKTOP_SMOKE = '1';

  const log = openSync(join(userDataDirectory(env), 'relaunch.log'), 'a');
  const helper = spawn(
    options.executable,
    [
      fileURLToPath(import.meta.url),
      options.packaged === true ? 'packaged' : 'dev',
      String(process.pid),
      ...options.args,
    ],
    {
      // Outside the bundle, which the helper may rename while it runs.
      cwd: homedir(),
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  helper.unref();
}

/**
 * @param pid - process to probe.
 * @returns whether it still exists.
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which cannot be ours.
    return error.code === 'EPERM';
  }
}

/** Helper entry point. */
async function runHelper() {
  const [mode, pidText, ...args] = process.argv.slice(2);
  if (mode !== 'dev' && mode !== 'packaged') throw new Error(`relaunch: invalid mode ${String(mode)}`);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`relaunch: invalid pid ${String(pidText)}`);

  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`relaunch: process ${String(pid)} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const log = (message) => process.stdout.write(`relaunch: ${message}\n`);
  let executable;
  let appArgs;
  if (mode === 'packaged') {
    executable = await restampPackagedBundle(packagedAppBundle(), log);
    // A packaged app loads Resources/app by itself; no app directory argument.
    appArgs = args;
  } else {
    executable = ensureBrandedBundle({ log });
    appArgs = [...args, PROJECT_ROOT];
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Keep the new instance's output in the same log as this helper's, so a
  // relaunch that fails to start is diagnosable.
  const child = spawn(executable, appArgs, {
    // Not PROJECT_ROOT: in packaged mode that path is inside the bundle this
    // helper may just have renamed, and spawn fails with ENOENT on a missing
    // cwd. The packaged app changes to the home directory on its own.
    cwd: mode === 'packaged' ? homedir() : PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env,
  });
  child.unref();
  process.stdout.write(`relaunch: started ${executable}\n`);
}

/**
 * Apply the saved identity to an installed packaged bundle and re-sign it.
 *
 * The `.app` directory is renamed to match when its parent is writable and the
 * new name is free, so Finder shows the new name too; otherwise it keeps its
 * old file name and only the menu bar and Cmd-Tab change.
 *
 * @param app - installed `.app` directory.
 * @param log - diagnostics sink.
 * @returns the executable to start.
 */
export async function restampPackagedBundle(app, log) {
  let target = app;
  const name = resolveBranding({ root: join(app, 'Contents', 'Resources', 'app') }).name;
  const renamed = join(dirname(app), `${name}.app`);
  if (renamed !== app && !existsSync(renamed)) {
    try {
      renameSync(app, renamed);
      target = renamed;
      log(`renamed ${basename(app)} -> ${basename(renamed)}`);
    } catch (error) {
      log(`kept bundle name ${basename(app)} (${String(error?.code ?? error)})`);
    }
  }

  // Resolved after any rename, so the default icon path points into the bundle
  // as it now exists.
  stampBundle(target, resolveBranding({ root: join(target, 'Contents', 'Resources', 'app') }));
  signAdHoc(target);
  log(`stamped and re-signed ${target}`);
  return join(target, 'Contents', 'MacOS', 'Electron');
}

/**
 * Re-seal a bundle with an ad-hoc signature.
 *
 * Only the outer bundle changes (Info.plist and the icon), so nested code
 * keeps its signatures and no `--deep` pass over the whole harness is needed.
 *
 * @param app - `.app` directory.
 */
export function signAdHoc(app) {
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: ['ignore', 'ignore', 'pipe'] });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHelper().catch((error) => {
    process.stderr.write(`${new Date().toISOString()} ${String(error?.stack ?? error)}\n`);
    process.exit(1);
  });
}
