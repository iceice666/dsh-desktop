/**
 * Launch the app from the branded bundle, so macOS shows its real name and
 * icon instead of "Electron".
 *
 * Arguments are forwarded to Electron ahead of the app directory, which lets
 * the Chromium workaround flags from the README pass through unchanged.
 *
 * Usage: node scripts/start.mjs [electron flags...]
 */

import { spawn } from 'node:child_process';

import { PROJECT_ROOT } from '../src/main/branding.js';
import { ensureBrandedBundle } from '../src/main/branded-bundle.js';

const verbose = process.env.DSH_DESKTOP_VERBOSE === '1';
const executable = ensureBrandedBundle({
  log: (message) => {
    if (verbose) process.stdout.write(`dsh-desktop: ${message}\n`);
  },
});

const child = spawn(executable, [...process.argv.slice(2), PROJECT_ROOT], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
});

// Pass Ctrl-C and termination through, so the app's own `before-quit` teardown
// still disposes the host tree.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 128));
});
