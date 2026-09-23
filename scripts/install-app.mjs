/**
 * Install the packaged app from dist/ into an Applications folder.
 *
 * Default target is `~/Applications`, which needs no administrator rights and
 * which Launchpad and Spotlight index. `--system` targets `/Applications`.
 *
 * An existing copy with the same name is replaced, but only when it is not
 * running: replacing a live bundle pulls files out from under Chromium's
 * helpers. User data (`~/Library/Application Support/dsh-desktop`, which also
 * holds the app's DSH home) is never touched.
 *
 * The copy keeps its ad-hoc signature and has no quarantine attribute, because
 * it was built on this machine rather than downloaded.
 *
 * Usage: node scripts/install-app.mjs [--system]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PROJECT_ROOT, resolveBranding } from '../src/main/branding.js';
import { registerWithLaunchServices } from '../src/main/branded-bundle.js';

const system = process.argv.includes('--system');
const name = resolveBranding({ preferences: {} }).name;
const source = join(PROJECT_ROOT, 'dist', `${name}.app`);
if (!existsSync(source)) {
  console.error(`install: ${source} not found; run \`pnpm package\` first`);
  process.exit(1);
}

const directory = system ? '/Applications' : join(homedir(), 'Applications');
const target = join(directory, `${name}.app`);

const running = spawnSync('pgrep', ['-f', `${target}/Contents/MacOS/`], { encoding: 'utf8' });
if (running.status === 0 && running.stdout.trim().length > 0) {
  console.error(`install: ${name} is running from ${target}; quit it first`);
  process.exit(1);
}

mkdirSync(directory, { recursive: true });
rmSync(target, { recursive: true, force: true });
execFileSync('ditto', [source, target], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', target], { stdio: 'inherit' });
registerWithLaunchServices(target);
console.log(`installed ${target}`);
