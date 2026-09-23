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

import { PROJECT_ROOT, userDataDirectory } from './branding.js';

/** Info.plist key recording which icon the bundle was stamped with. */
export const ICON_SOURCE_KEY = 'DSHDesktopIconSource';

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
 * DSH home used by the packaged app.
 *
 * The packaged app ships its own harness, and DSH maintains
 * `$DSH_HOME/profiles/node_modules` as links into whichever installation last
 * launched. Sharing `~/.dsh` with the `dsh` CLI would make the two keep
 * rewriting those links under each other, so the app gets a home of its own.
 * `DSH_DESKTOP_DSH_HOME` overrides it; an inherited `DSH_HOME` does not, since
 * a terminal launch would otherwise silently share the CLI's home.
 *
 * @param env - environment to read the override from.
 * @returns absolute DSH home path.
 */
export function packagedDshHome(env = process.env) {
  const override = env.DSH_DESKTOP_DSH_HOME;
  if (override !== undefined && override.length > 0) return override;
  return join(userDataDirectory(env), 'dsh-home');
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
