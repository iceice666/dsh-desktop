/**
 * Facts about the packaged `.app` layout, shared by the main process, the
 * relaunch helper, and the packager.
 *
 * Packaged layout (see scripts/package.mjs):
 *
 *   <Name>.app/Contents/
 *     MacOS/Electron                    stock Electron executable
 *     Resources/app/                    this project: package.json, src, plugins, assets
 *     Resources/app/runtime/node_modules   the bundled DSH harness (hoisted, no symlinks out)
 *
 * Detection is by layout, not by `app.isPackaged`, because the relaunch helper
 * and the branding resolver run where Electron's `app` is not available.
 *
 * Like `branding.js`, this module imports nothing from Electron.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { PROJECT_ROOT } from './branding.js';

/** Info.plist key recording which icon the bundle was stamped with. */
export const ICON_SOURCE_KEY = 'DSHDesktopIconSource';

/**
 * Info.plist key naming whoever owns the installed bundle. `nix` means the
 * bundle was built by the flake and is read-only in the store (or a copy the
 * next `switch` overwrites), so the app must never rewrite or rename it.
 */
export const MANAGED_BY_KEY = 'DSHDesktopManagedBy';

/** Value of {@link ICON_SOURCE_KEY} when the bundled default icon was used. */
export const DEFAULT_ICON_SOURCE = 'default';

/**
 * @param root - project root to test; defaults to this installation's.
 * @returns whether `root` sits at `<X>.app/Contents/Resources/app`.
 */
export function isPackagedLayout(root = PROJECT_ROOT) {
  return (
    basename(root) === 'app' &&
    basename(dirname(root)) === 'Resources' &&
    basename(dirname(dirname(root))) === 'Contents' &&
    dirname(dirname(dirname(root))).endsWith('.app')
  );
}

/**
 * @param root - project root inside a packaged bundle.
 * @returns the enclosing `.app` directory.
 */
export function packagedAppBundle(root = PROJECT_ROOT) {
  return dirname(dirname(dirname(root)));
}

/**
 * @param root - project root.
 * @returns the bundled harness anchor, or `undefined` when none is shipped.
 */
export function bundledHarnessAnchor(root = PROJECT_ROOT) {
  const anchor = join(root, 'runtime', 'node_modules');
  return existsSync(join(anchor, '@deepseek-ai', 'dsh', 'package.json')) ? anchor : undefined;
}

/**
 * @param root - project root.
 * @returns who manages the bundle (`'nix'`), or `undefined` when the app may
 *   restamp itself.
 */
export function bundleManager(root = PROJECT_ROOT) {
  if (!isPackagedLayout(root)) return undefined;
  return readBundleKey(packagedAppBundle(root), MANAGED_BY_KEY);
}

/**
 * Read one string key from a bundle's Info.plist.
 * @param app - `.app` directory.
 * @param key - top-level key.
 * @returns the value, or `undefined` when absent.
 */
export function readBundleKey(app, key) {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}
