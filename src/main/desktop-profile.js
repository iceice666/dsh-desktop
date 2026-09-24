/**
 * Where the desktop app keeps its DSH state, and the profile it boots.
 *
 * Like upstream DSH Desktop, the app shares the CLI's DSH home (`~/.dsh`) —
 * settings, credentials, `.env`, sessions, and workspaces are common to both —
 * and boots its own profile, `desktop`, which the CLI reserves for Electron
 * (`dsh --profile desktop` is rejected). Plugins and the profile patch layer
 * therefore stay separate from `dsh web` while everything else is shared.
 *
 * The profile is loaded as an application-owned directory
 * (`loadProfileDirectory` + `runProfile({ resolvedProfile })`), so its module
 * fallback links live inside the profile and the shared
 * `$DSH_HOME/profiles/node_modules` index the CLI maintains is never written.
 *
 * Like `branding.js`, this module imports nothing from Electron.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Profile name upstream reserves for the Electron application. */
export const DESKTOP_PROFILE_NAME = 'desktop';

/** Bundles every desktop profile starts with, in this order. */
export const REQUIRED_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

/** Diagnostic prefix passed to the harness loaders. */
const BIN_NAME = 'dsh-desktop';

/**
 * The CLI's default DSH home.
 * @param home - OS home directory.
 * @returns absolute path of `~/.dsh`.
 */
export function defaultDshHome(home = homedir()) {
  return join(home, '.dsh');
}

/**
 * Resolve the DSH home this launch uses.
 *
 * `DSH_DESKTOP_DSH_HOME` always wins. Otherwise the packaged app uses `~/.dsh`
 * and ignores an inherited `DSH_HOME`, so a launch from a terminal (or from an
 * agent shell the app itself spawned) cannot silently move it elsewhere; the
 * development build honours `DSH_HOME` exactly like the CLI, which the probes
 * rely on.
 *
 * @param options - `{ env, packaged, home }`.
 * @returns `{ path, source }`, where `source` is `override`, `env`, or `default`.
 */
export function resolveDesktopDshHome(options = {}) {
  const { env = process.env, packaged = false, home = homedir() } = options;
  const override = env.DSH_DESKTOP_DSH_HOME?.trim();
  if (override) return { path: override, source: 'override' };
  const inherited = env.DSH_HOME?.trim();
  if (!packaged && inherited) return { path: inherited, source: 'env' };
  return { path: defaultDshHome(home), source: 'default' };
}

/**
 * Put the required bundles first and keep every other bundle in its order.
 * @param current - bundle list from the profile manifest.
 * @returns the normalized list.
 */
export function desktopBundleList(current) {
  const required = new Set(REQUIRED_BUNDLES);
  return [...REQUIRED_BUNDLES, ...current.filter((name) => !required.has(name))];
}

/**
 * Create the desktop profile when missing and repair its bundle list.
 *
 * @param appBoot - the harness's `@deepseek-ai/dsh-app-boot` namespace.
 * @param home - DSH home.
 * @returns the absolute profile directory.
 */
export function ensureDesktopProfile(appBoot, home) {
  const dir = join(home, appBoot.PROFILES_DIR ?? 'profiles', DESKTOP_PROFILE_NAME);
  if (!existsSync(join(dir, 'package.json'))) appBoot.initProfile(dir, [...REQUIRED_BUNDLES]);

  const manifest = appBoot.readProfileManifest(BIN_NAME, dir);
  const raw = manifest.dsh?.profile?.bundles;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string'))) {
    throw new Error(`${BIN_NAME}: dsh.profile.bundles in ${join(dir, 'package.json')} must be an array of package names`);
  }
  const current = raw ?? [];
  const bundles = desktopBundleList(current);
  if (bundles.length !== current.length || bundles.some((name, index) => name !== current[index])) {
    appBoot.writeProfileManifest(dir, {
      ...manifest,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
    });
  }
  return dir;
}

/**
 * Prepare the desktop profile for `runProfile({ resolvedProfile })`.
 *
 * @param options - `{ appBoot, home, installAnchor }`; `installAnchor` is the
 *   harness's `@deepseek-ai/dsh/package.json`.
 * @returns the resolved profile runtime.
 * @throws when the harness predates application-owned profiles.
 */
export function resolveDesktopProfile(options) {
  const { appBoot, home, installAnchor } = options;
  if (typeof appBoot.loadProfileDirectory !== 'function') {
    throw new Error(
      `${BIN_NAME}: this DSH installation cannot load an application-owned profile; ` +
        'upgrade DSH, or set DSH_DESKTOP_PROFILE=web to boot a CLI profile instead',
    );
  }
  const dir = ensureDesktopProfile(appBoot, home);
  return { profile: appBoot.loadProfileDirectory(BIN_NAME, dir, installAnchor), installAnchor };
}
