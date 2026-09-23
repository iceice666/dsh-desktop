/**
 * Headless gate: syntax, pure-logic tests, and the live admission contract.
 *
 * Everything here runs without a graphical application, so the shell's
 * security-critical behaviour stays verifiable in a sandbox or on CI where
 * Chromium cannot start.
 *
 * Usage: node scripts/check.mjs
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * Run one step and report its outcome.
 * @param label - human-readable step name.
 * @param args - node arguments.
 * @returns whether the step succeeded.
 */
function step(label, args) {
  process.stdout.write(`\n── ${label}\n`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  return result.status === 0;
}

const failures = [];

process.stdout.write('\n── syntax\n');
const sourceDirectories = [
  join('src', 'main'),
  join('src', 'preload'),
  join('plugins', 'dsh-desktop-branding', 'lib'),
];
const sources = sourceDirectories.flatMap((directory) =>
  readdirSync(join(root, directory))
    .filter((name) => name.endsWith('.js') || name.endsWith('.cjs'))
    .map((name) => join(directory, name)),
);
for (const relative of sources) {
  const name = relative;
  const result = spawnSync(process.execPath, ['--check', relative], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status === 0) process.stdout.write(`   ok  ${relative}\n`);
  else failures.push(`syntax:${name}`);
}

if (!step('unit: renderer capability and header policy', ['scripts/test-access-header.mjs'])) {
  failures.push('unit:access-header');
}

if (!step('unit: window containment policy', ['scripts/test-navigation.mjs'])) {
  failures.push('unit:navigation');
}

if (!step('unit: harness discovery', ['scripts/test-find-harness.mjs'])) {
  failures.push('unit:find-harness');
}

if (!step('unit: application identity', ['scripts/test-branding.mjs'])) {
  failures.push('unit:branding');
}

if (!step('unit: branding routes and saved preferences', ['scripts/test-branding-routes.mjs'])) {
  failures.push('unit:branding-routes');
}

if (!step('admission: live host contract', ['scripts/test-admission.mjs'])) {
  failures.push('admission');
}

if (failures.length > 0) {
  process.stderr.write(`\ncheck FAILED: ${failures.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('\ncheck passed\n');
