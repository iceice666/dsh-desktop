/**
 * Electron main process: own the DSH host tree and one desktop shell generation.
 *
 * The renderer runs the stock upstream web client against the host's own
 * loopback carrier. No Electron API is exposed to the page and no renderer IPC
 * plugin system exists, so the window keeps Chromium's strict sandbox.
 */

import { app } from 'electron';

import { findHarnessAnchor } from './find-harness.js';
import { startHost, resolveOrigin, resolveAuthenticationUrl } from './host.js';
import { ShellGeneration } from './shell-generation.js';

const verbose = process.env.DSH_DESKTOP_VERBOSE === '1';

/**
 * Emit a shell diagnostic line.
 * @param message - text to log.
 */
function log(message) {
  if (verbose) process.stdout.write(`dsh-desktop: ${message}\n`);
}

// Chromium writes its caches under userData. Honour an explicit override so the
// app can run with a constrained HOME (a sandboxed checkout, CI) where the
// platform default is not writable; without a writable cache directory the very
// first navigation fails with ERR_FAILED.
const userDataOverride = process.env.DSH_DESKTOP_USER_DATA;
if (userDataOverride !== undefined) app.setPath('userData', userDataOverride);

/** Live host tree for the current generation. */
let host;
/** Live shell generation. */
let generation;
/** Set once shutdown has begun, so `before-quit` runs its teardown once. */
let quitting = false;

/**
 * Boot the host tree and mount the first shell generation.
 */
async function main() {
  const { anchor, source } = findHarnessAnchor();
  log(`using DSH from ${source}`);

  host = await startHost({
    profile: process.env.DSH_DESKTOP_PROFILE ?? 'web',
    anchor,
    port: Number(process.env.DSH_DESKTOP_PORT ?? 0),
    log,
  });

  const origin = resolveOrigin(host.ctx);
  const authenticationUrl = resolveAuthenticationUrl(host.ctx, origin);

  // Smoke mode verifies that the client really mounted and then exits, so a
  // launch can be validated without a human watching the window.
  const smoke = process.env.DSH_DESKTOP_SMOKE === '1';

  generation = new ShellGeneration({ log });
  await generation.mount({
    origin,
    authenticationUrl,
    title: 'DeepSeek Harness',
    verifyClient: smoke,
  });

  if (smoke) {
    process.stdout.write('dsh-desktop: SMOKE OK\n');
    await teardown();
    app.exit(0);
  }
}

/**
 * Release the shell generation and the host tree, in that order.
 *
 * The window is torn down first so no in-flight renderer request can reach a
 * half-disposed Cordis tree.
 */
async function teardown() {
  const shell = generation;
  generation = undefined;
  if (shell !== undefined) {
    try {
      await shell.release();
    } catch (error) {
      process.stderr.write(`dsh-desktop: shell release failed: ${String(error)}\n`);
    }
  }

  const tree = host;
  host = undefined;
  if (tree !== undefined) {
    try {
      await tree.dispose();
    } catch (error) {
      process.stderr.write(`dsh-desktop: host disposal failed: ${String(error)}\n`);
    }
  }
}

// A second launch must not boot a second host tree against the same profile
// directory: two Cordis generations would contend for the same session store.
// The already-running instance is brought forward instead.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    generation?.show();
  });

  app
    .whenReady()
    .then(main)
    .catch(async (error) => {
      // A startup failure is usually an environment problem the user can fix,
      // so lead with the message. The stack only helps when the cause is a
      // defect here, and is kept behind the verbose flag.
      process.stderr.write(`\n${String(error?.message ?? error)}\n\n`);
      if (verbose && error?.stack !== undefined) {
        process.stderr.write(`${String(error.stack)}\n`);
      }
      await teardown();
      app.exit(1);
    });
}

// Clicking the Dock icon with no window open is the standard macOS way to
// return to a running app.
app.on('activate', () => {
  generation?.show();
});

app.on('window-all-closed', () => {
  // On macOS an app normally stays resident when its last window closes, but
  // this shell's whole purpose is that one window, and the host tree it owns is
  // expensive to keep running unseen.
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  // Cordis disposal is asynchronous; hold the quit until the tree has released
  // its subprocesses and the session log has been flushed.
  event.preventDefault();
  void teardown().finally(() => {
    app.exit(0);
  });
});
