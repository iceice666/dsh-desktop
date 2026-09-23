/**
 * Locate the DSH installation this desktop app should drive.
 *
 * The app deliberately does not vendor its own harness copy: it runs the same
 * installation the `dsh` CLI uses, so profiles, credentials, and installed
 * plugins are shared. That installation therefore has to be discovered rather
 * than configured, because requiring the user to supply an internal store path
 * would make the app unusable without reading its source.
 *
 * Discovery follows the `dsh` binary, which is the same thing the user already
 * runs. An explicit `DSH_ANCHOR` still wins, for a checkout that is not the one
 * on `PATH`.
 *
 * The packaged app is the exception: it ships its own harness under
 * `Resources/app/runtime/node_modules` (see scripts/package.mjs), pinned to the
 * one DSH release its Electron build can load, and never looks at `PATH`.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { bundledHarnessAnchor, isPackagedLayout } from './packaged.js';

const require = createRequire(import.meta.url);

/** Entry point that identifies a harness installation. */
const PROBE_SPECIFIER = '@deepseek-ai/dsh/lib/profile-boot.js';

/**
 * A second package the host boot needs.
 *
 * Checking it matters: under pnpm the top-level anchor exposes `dsh` but not
 * its dependencies, so an anchor that resolves only the entry point would be
 * accepted here and then fail during boot.
 */
const SIBLING_SPECIFIER = '@deepseek-ai/dsh-app-boot';

/**
 * Find a node_modules directory from which the harness can be resolved.
 *
 * @returns `{ anchor, source }` describing where the installation was found.
 * @throws when no installation can be located, with guidance rather than a bare
 *   failure.
 */
export function findHarnessAnchor(options = {}) {
  const root = options.root;
  const attempts = [];

  const explicit = process.env.DSH_ANCHOR;
  if (explicit !== undefined && explicit.length > 0) {
    if (canResolveFrom(explicit)) return { anchor: explicit, source: 'DSH_ANCHOR' };
    attempts.push(`DSH_ANCHOR=${explicit} (does not resolve ${PROBE_SPECIFIER})`);
  }

  if (isPackagedLayout(root)) {
    const bundled = bundledHarnessAnchor(root);
    if (bundled !== undefined && canResolveFrom(bundled)) return { anchor: bundled, source: 'bundled' };
    // A packaged app with a broken bundle is a packaging defect; falling back
    // to whatever `dsh` happens to be on PATH would hide it behind a version
    // mismatch with this Electron build.
    throw new Error(
      `dsh-desktop: the bundled DSH harness is missing or incomplete (${String(bundled)}); reinstall the app`,
    );
  }

  for (const candidate of candidatesFromDshBinary(attempts)) {
    if (canResolveFrom(candidate.anchor)) return candidate;
  }

  throw new Error(
    [
      'dsh-desktop: could not locate a DSH installation.',
      '',
      'Tried:',
      ...attempts.map((line) => `  - ${line}`),
      '',
      'Install DSH so that `dsh` is on PATH, or set DSH_ANCHOR to the',
      'node_modules directory from which @deepseek-ai/dsh can be resolved.',
    ].join('\n'),
  );
}

/**
 * Whether a complete harness resolves from a given node_modules anchor.
 *
 * Resolution — not mere directory existence — is the real test, because pnpm
 * stores packages behind a content-addressed layout that a path check cannot
 * validate. Both the entry point and one of its dependencies must resolve, the
 * latter from where `dsh` itself lives, mirroring what the host boot does.
 *
 * @param anchor - candidate node_modules directory.
 * @returns whether the installation is usable.
 */
function canResolveFrom(anchor) {
  try {
    const entry = require.resolve(PROBE_SPECIFIER, { paths: [anchor] });
    require.resolve(SIBLING_SPECIFIER, { paths: [anchor, dirname(entry)] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive candidate anchors from the `dsh` executable on PATH.
 *
 * A package manager may install `dsh` as a symlink or as a generated shim. A
 * symlink is followed directly; a shim is scanned for the absolute path it
 * execs, which is how pnpm records its target.
 *
 * @param attempts - diagnostic sink describing what was tried.
 * @returns candidate anchors in priority order.
 */
function candidatesFromDshBinary(attempts) {
  const candidates = [];

  let binary;
  try {
    binary = execFileSync('sh', ['-lc', 'command -v dsh'], { encoding: 'utf8' }).trim();
  } catch {
    attempts.push('`dsh` was not found on PATH');
    return candidates;
  }
  if (binary.length === 0) {
    attempts.push('`dsh` was not found on PATH');
    return candidates;
  }

  for (const entry of targetsFromBinary(binary)) {
    // `…/node_modules/@deepseek-ai/dsh/lib/bin.js` → `…/node_modules`
    const marker = `${'node_modules'}${'/'}`;
    const index = entry.lastIndexOf(marker);
    if (index === -1) continue;
    const anchor = entry.slice(0, index + marker.length - 1);
    if (!candidates.some((candidate) => candidate.anchor === anchor)) {
      candidates.push({ anchor, source: `dsh on PATH (${binary})` });
    }
  }

  if (candidates.length === 0) {
    attempts.push(`\`dsh\` at ${binary} did not reveal a node_modules path`);
  }
  return candidates;
}

/**
 * Extract candidate module paths from the `dsh` executable.
 *
 * @param binary - absolute path of the `dsh` executable.
 * @returns absolute paths the executable appears to run.
 */
function targetsFromBinary(binary) {
  const targets = [];

  // A symlink points straight at the package entry point.
  try {
    const real = require('node:fs').realpathSync(binary);
    if (real !== binary) targets.push(real);
  } catch {
    // Not a symlink, or unreadable; the shim scan below still applies.
  }

  // A shim is a text file naming its target. pnpm writes an explicit
  // `cmd-shim-target=` comment; other shims are matched by their exec line.
  try {
    const text = readFileSync(binary, 'utf8');
    for (const match of text.matchAll(/(\/[^\s"']*node_modules\/[^\s"']*\.(?:js|cjs|mjs))/gu)) {
      const candidate = match[1];
      if (!targets.includes(candidate)) targets.push(candidate);
    }
    // Shims may reference their target relative to the binary's directory.
    for (const match of text.matchAll(/\$basedir\/((?:\.\.\/)[^\s"']*\.(?:js|cjs|mjs))/gu)) {
      const candidate = resolve(dirname(binary), match[1]);
      if (!targets.includes(candidate)) targets.push(candidate);
    }
  } catch {
    // A binary executable is not readable as text; nothing more to try.
  }

  return targets.filter((target) => existsSync(target) || target.includes(join('node_modules', '')));
}
