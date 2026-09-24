/**
 * Build (or reuse) a copy of Electron.app stamped with this app's identity.
 *
 * On macOS the menu-bar title, Cmd-Tab label, and Finder name come from the
 * bundle's Info.plist, which the running process cannot change: `app.setName`
 * only affects Electron's own menus and About panel. Running `electron .`
 * therefore always shows "Electron". The fix, short of full packaging, is to
 * launch from a bundle whose Info.plist already carries the right name, bundle
 * identifier, and icon.
 *
 * The copy lives in `.electron-app/` and is rebuilt only when its inputs change
 * (Electron version, name, bundle id, icon bytes). On APFS the copy is a clone,
 * so it costs almost no disk space.
 *
 * The executable keeps its upstream name `Electron`: Chromium locates its
 * helper apps relative to that name, and renaming it would also require
 * renaming and re-signing every helper.
 *
 * Never rebuild while an app is running from the bundle: Chromium launches
 * helper apps from inside it for as long as it runs. `relaunch.js` therefore
 * waits for the old process to exit before calling this.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

import { PROJECT_ROOT, iconIdentity, resolveBranding, userDataDirectory } from './branding.js';
import { ICON_SOURCE_KEY, isPackagedLayout } from './packaged.js';

const require = createRequire(import.meta.url);

/** Directory holding the generated bundle. Ignored by git. */
export const BUNDLE_DIRECTORY = join(PROJECT_ROOT, '.electron-app');

/** Bumped whenever the stamping procedure below changes. */
const STAMP_FORMAT = 2;

/**
 * Path of the stock Electron executable installed in node_modules.
 *
 * Read from the package's `path.txt` rather than `require('electron')`: inside
 * an Electron process that specifier resolves to the Electron API, not to the
 * executable path.
 *
 * @returns absolute path to the executable.
 */
export function stockElectronExecutable() {
  const packageDirectory = dirname(require.resolve('electron/package.json'));
  const relative = readFileSync(join(packageDirectory, 'path.txt'), 'utf8').trim();
  const executable = isAbsolute(relative) ? relative : join(packageDirectory, 'dist', relative);
  if (!existsSync(executable)) {
    throw new Error(`dsh-desktop: Electron executable missing at ${executable}; run pnpm install`);
  }
  return executable;
}

/**
 * Ensure the branded bundle exists and is current.
 *
 * @param options - `{ log, env }`; `env` selects which preferences and
 *   overrides apply (defaults to `process.env`).
 * @returns absolute path to the executable inside the branded bundle, or the
 *   stock executable on platforms other than macOS.
 */
export function ensureBrandedBundle(options = {}) {
  const log = options.log ?? (() => {});
  const stock = stockElectronExecutable();
  if (process.platform !== 'darwin') return stock;

  const branding = resolveBranding({ env: options.env ?? process.env });
  const stockApp = dirname(dirname(dirname(stock)));
  if (!stockApp.endsWith('.app')) {
    throw new Error(`dsh-desktop: unexpected Electron layout: ${stock}`);
  }

  const icon = iconForBundle(branding);
  const stamp = computeStamp(stockApp, branding, icon);
  const app = join(BUNDLE_DIRECTORY, `${branding.name}.app`);
  const executable = join(app, 'Contents', 'MacOS', 'Electron');
  const stampFile = join(BUNDLE_DIRECTORY, '.stamp');

  if (existsSync(executable) && readOrEmpty(stampFile) === stamp) return executable;

  log(`building branded bundle ${app}`);
  // Clear everything, not just the target: a rename would otherwise leave the
  // previously named bundle behind, still registered with LaunchServices.
  rmSync(BUNDLE_DIRECTORY, { recursive: true, force: true });
  mkdirSync(BUNDLE_DIRECTORY, { recursive: true });

  // `-c` asks for an APFS clone; the copy is then nearly free.
  try {
    execFileSync('cp', ['-cR', stockApp, app]);
  } catch {
    execFileSync('cp', ['-R', stockApp, app]);
  }

  stampBundle(app, branding);

  writeFileSync(stampFile, stamp);
  return executable;
}

/**
 * Write an identity into an existing `.app` bundle: display name, bundle
 * identifier, and icon.
 *
 * Shared by the dev launcher, the packager, and the packaged relaunch helper,
 * so every bundle this project produces is stamped the same way. Signing is the
 * caller's business: the dev bundle runs unsigned-modified, the packaged one is
 * re-signed afterwards.
 *
 * @param app - `.app` directory to modify in place.
 * @param branding - resolved branding.
 * @param options - `{ version, register }`: optional marketing version to
 *   record; `register: false` skips LaunchServices (builds in a sandbox).
 */
export function stampBundle(app, branding, options = {}) {
  const plist = join(app, 'Contents', 'Info.plist');
  setPlist(plist, 'CFBundleName', branding.name);
  setPlist(plist, 'CFBundleDisplayName', branding.name);
  setPlist(plist, 'CFBundleIdentifier', branding.bundleId);
  if (options.version !== undefined) {
    setPlist(plist, 'CFBundleShortVersionString', options.version);
    setPlist(plist, 'CFBundleVersion', options.version);
  }

  const icon = iconForBundle(branding);
  if (icon !== undefined) {
    // Leave electron.icns in place: nothing else references it, and deleting
    // a sealed resource is needless churn.
    copyFileSync(icon, join(app, 'Contents', 'Resources', 'app.icns'));
    setPlist(plist, 'CFBundleIconFile', 'app.icns');
  }
  // Record which icon this bundle carries, so a packaged app can tell whether
  // the saved choice still needs a relaunch (branding-controller.js).
  setPlist(plist, ICON_SOURCE_KEY, iconIdentity(branding));

  if (options.register !== false) registerWithLaunchServices(app);
}

/**
 * Ask LaunchServices to re-read a bundle so Finder and the Dock pick up a new
 * name and icon instead of a cached entry. Best effort only.
 * @param app - `.app` directory.
 */
export function registerWithLaunchServices(app) {
  try {
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', app],
      { stdio: 'ignore' },
    );
  } catch {
    // Registration is cosmetic; the bundle still launches without it.
  }
}

/**
 * Pick the `.icns` to embed, converting a PNG override when needed.
 *
 * @param branding - resolved branding.
 * @returns path to an `.icns` file, or `undefined` for Electron's own icon.
 */
function iconForBundle(branding) {
  if (branding.iconIcns !== undefined) return branding.iconIcns;
  if (branding.iconPng === undefined) return undefined;
  return pngToIcns(branding.iconPng);
}

/**
 * Convert a square PNG to `.icns` with the system's `sips` and `iconutil`.
 *
 * @param png - source PNG, ideally 1024×1024.
 * @returns path to the generated `.icns`, cached by content hash.
 */
function pngToIcns(png) {
  const digest = createHash('sha256').update(readFileSync(png)).digest('hex').slice(0, 16);
  // Never inside a packaged bundle: writing there would break its seal.
  const cache = isPackagedLayout()
    ? join(userDataDirectory(), 'icon-cache')
    : join(PROJECT_ROOT, '.electron-cache', 'icons');
  const output = join(cache, `${digest}.icns`);
  if (existsSync(output)) return output;

  const iconset = join(cache, `${digest}.iconset`);
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const suffix = scale === 2 ? '@2x' : '';
      execFileSync('sips', [
        '-z', pixels, pixels, png,
        '--out', join(iconset, `icon_${String(size)}x${String(size)}${suffix}.png`),
      ], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', output]);
  rmSync(iconset, { recursive: true, force: true });
  return output;
}

/**
 * @param stockApp - stock Electron.app path.
 * @param branding - resolved branding.
 * @param icon - `.icns` that will be embedded, if any.
 * @returns a digest that changes whenever the bundle must be rebuilt.
 */
function computeStamp(stockApp, branding, icon) {
  const hash = createHash('sha256');
  hash.update(`format=${String(STAMP_FORMAT)}\n`);
  hash.update(`stock=${stockApp}\n`);
  hash.update(readFileSync(join(stockApp, 'Contents', 'Info.plist')));
  hash.update(`\nname=${branding.name}\nid=${branding.bundleId}\n`);
  if (icon !== undefined) hash.update(readFileSync(icon));
  return hash.digest('hex');
}

/**
 * Set a string key in a plist, creating it when missing.
 * @param plist - plist path.
 * @param key - top-level key.
 * @param value - string value.
 */
function setPlist(plist, key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, plist]);
}

/**
 * @param path - file to read.
 * @returns its text, or an empty string when it does not exist.
 */
function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
