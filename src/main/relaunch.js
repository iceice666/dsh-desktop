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
 * Usage (as the helper): ELECTRON_RUN_AS_NODE=1 <electron> relaunch.js <pid> [electron args...]
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_ROOT, userDataDirectory } from './branding.js';

/** How long the helper waits for the old process before giving up. */
const EXIT_TIMEOUT_MS = 60_000;

/**
 * Start the detached helper. The caller must quit right after.
 *
 * @param options - `{ executable, args, env }`: the Electron executable to run
 *   the helper with, the arguments the new instance should receive (without
 *   the app directory), and the environment to launch it with.
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
    [fileURLToPath(import.meta.url), String(process.pid), ...options.args],
    {
      cwd: PROJECT_ROOT,
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
  const [pidText, ...args] = process.argv.slice(2);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`relaunch: invalid pid ${String(pidText)}`);

  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`relaunch: process ${String(pid)} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const { ensureBrandedBundle } = await import('./branded-bundle.js');
  const executable = ensureBrandedBundle({
    log: (message) => process.stdout.write(`relaunch: ${message}\n`),
  });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Keep the new instance's output in the same log as this helper's, so a
  // relaunch that fails to start is diagnosable.
  const child = spawn(executable, [...args, PROJECT_ROOT], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env,
  });
  child.unref();
  process.stdout.write(`relaunch: started ${executable}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHelper().catch((error) => {
    process.stderr.write(`${new Date().toISOString()} ${String(error?.stack ?? error)}\n`);
    process.exit(1);
  });
}
