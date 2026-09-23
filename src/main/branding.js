/**
 * Application identity: the name and icon the OS shows for this app.
 *
 * One resolver feeds every consumer — the running main process (Dock icon,
 * app menu, About panel), the launcher that stamps the dev `.app` bundle
 * (menu-bar name, Cmd-Tab, Finder), and the Settings page. Keeping them on the
 * same function means a choice can never brand one and not the others.
 *
 * Each field resolves through three layers, highest first:
 *
 * 1. environment variables — a per-launch override, never persisted;
 * 2. preferences saved from the Settings page (`branding.json` in userData);
 * 3. defaults from `package.json` (`productName`) and `assets/`.
 *
 * This module imports nothing from Electron: the launcher runs under plain
 * Node before any Electron process exists, and must read the same file.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, two levels above this file. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Bundle identifier used when neither package.json nor the env supplies one. */
const DEFAULT_BUNDLE_ID = 'dev.dsh-desktop';

/** Name used when package.json carries no `productName`. */
const FALLBACK_NAME = 'DeepSeek Harness';

/**
 * Chromium userData directory name used before the app had a product name.
 *
 * Electron derives the default userData path from the app name, so renaming
 * the app would otherwise silently move cookies, local storage, and caches to
 * a fresh directory. The directory stays pinned to this name regardless of the
 * display name.
 */
export const USER_DATA_DIRECTORY_NAME = 'dsh-desktop';

/** Preferences file inside userData. */
const PREFERENCES_FILE = 'branding.json';

/** Directory inside userData holding copies of user-chosen icons. */
const ICON_DIRECTORY = 'branding';

/** Longest accepted display name. Menu bars truncate long before this. */
export const MAX_NAME_LENGTH = 64;

/** Icon file types accepted from the user. */
export const ICON_EXTENSIONS = Object.freeze(['.png', '.icns']);

/** Largest accepted icon file; a 1024² 16-bit PNG is about 2 MiB. */
const MAX_ICON_BYTES = 16 * 1024 * 1024;

/**
 * Characters that must not appear in a name used as a bundle path component.
 * `/` would create a subdirectory, `:` is the legacy HFS separator, and control
 * characters have no business in a menu bar.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[/:\u0000-\u001f\u007f]/u;

/**
 * Validate and normalise a display name.
 *
 * @param value - candidate name.
 * @returns the trimmed name.
 * @throws when the name is empty, too long, or unusable as a bundle name.
 */
export function normaliseName(value) {
  if (typeof value !== 'string') throw new Error('dsh-desktop: app name must be a string');
  const name = value.trim();
  if (name.length === 0) throw new Error('dsh-desktop: app name must not be empty');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`dsh-desktop: app name must be at most ${String(MAX_NAME_LENGTH)} characters`);
  }
  if (UNSAFE_NAME.test(name) || name.startsWith('.')) {
    throw new Error(`dsh-desktop: invalid app name ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Resolve the userData directory without Electron.
 *
 * Mirrors what `src/main/index.js` pins with `app.setPath('userData', …)`, so
 * the launcher and the running app agree on where preferences live.
 *
 * @param env - environment to read the override from.
 * @returns absolute userData path.
 */
export function userDataDirectory(env = process.env) {
  const override = env.DSH_DESKTOP_USER_DATA;
  if (override !== undefined && override.length > 0) return resolve(override);
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', USER_DATA_DIRECTORY_NAME);
  }
  if (process.platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), USER_DATA_DIRECTORY_NAME);
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), USER_DATA_DIRECTORY_NAME);
}

/**
 * Persisted Settings-page choices. Every method is synchronous: the file is a
 * few bytes and the launcher reads it before anything else runs.
 */
export class BrandingPreferences {
  #directory;

  /** @param directory - userData directory. */
  constructor(directory) {
    this.#directory = directory;
  }

  /** @returns absolute path of the preferences file. */
  get path() {
    return join(this.#directory, PREFERENCES_FILE);
  }

  /**
   * Read saved choices. A missing, corrupt, or hand-edited-into-nonsense file
   * degrades to "nothing saved" rather than blocking startup; an icon whose
   * file has since disappeared is likewise dropped.
   *
   * @returns `{ name?, icon? }`.
   */
  read() {
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return {};
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result = {};
    try {
      if (raw.name !== undefined) result.name = normaliseName(raw.name);
    } catch {
      // An invalid saved name is ignored, not fatal.
    }
    if (
      typeof raw.icon === 'string' &&
      isAbsolute(raw.icon) &&
      ICON_EXTENSIONS.includes(extname(raw.icon).toLowerCase()) &&
      existsSync(raw.icon)
    ) {
      result.icon = raw.icon;
    }
    return result;
  }

  /**
   * Save the display name, or clear it with `undefined`.
   * @param name - new name.
   * @returns the saved choices.
   */
  setName(name) {
    const next = { ...this.read() };
    if (name === undefined) delete next.name;
    else next.name = normaliseName(name);
    this.#write(next);
    return next;
  }

  /**
   * Adopt an icon file, or clear the choice with `undefined`.
   *
   * The file is copied into userData under a content-addressed name, so the
   * saved choice survives the user moving or deleting the original, and a
   * rebuilt bundle notices the bytes changed.
   *
   * @param source - absolute path of a `.png` or `.icns` file.
   * @returns the saved choices.
   * @throws when the file is missing, too large, or of an unsupported type.
   */
  setIcon(source) {
    const next = { ...this.read() };
    if (source === undefined) {
      delete next.icon;
      this.#write(next);
      this.#pruneIcons(undefined);
      return next;
    }

    const kind = extname(source).toLowerCase();
    if (!ICON_EXTENSIONS.includes(kind)) {
      throw new Error(`dsh-desktop: icon must be one of ${ICON_EXTENSIONS.join(', ')}`);
    }
    const bytes = readFileSync(source);
    if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
      throw new Error('dsh-desktop: icon file is empty or too large');
    }
    if (!hasIconSignature(bytes, kind)) {
      throw new Error(`dsh-desktop: ${source} is not a valid ${kind.slice(1)} file`);
    }

    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const directory = join(this.#directory, ICON_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    const target = join(directory, `icon-${digest}${kind}`);
    if (!existsSync(target)) copyFileSync(source, target);

    next.icon = target;
    this.#write(next);
    this.#pruneIcons(target);
    return next;
  }

  /** @param value - choices to persist atomically. */
  #write(value) {
    mkdirSync(this.#directory, { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, this.path);
  }

  /** @param keep - icon copy still referenced, if any. */
  #pruneIcons(keep) {
    const directory = join(this.#directory, ICON_DIRECTORY);
    let names;
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(directory, name);
      if (path !== keep && name.startsWith('icon-')) rmSync(path, { force: true });
    }
  }
}

/**
 * Check the file's magic bytes, so a renamed text file is rejected up front
 * instead of failing later inside `sips` or `nativeImage`.
 *
 * @param bytes - file content.
 * @param kind - lowercased extension.
 * @returns whether the content matches the extension.
 */
function hasIconSignature(bytes, kind) {
  if (kind === '.png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (kind === '.icns') return bytes.subarray(0, 4).toString('latin1') === 'icns';
  return false;
}

/**
 * Resolve the application identity.
 *
 * @param options - `{ env, root, preferences }`; `preferences` is the saved
 *   Settings-page choice object, read from userData when omitted.
 * @returns `{ name, bundleId, iconPng, iconIcns, sources }` where either icon
 *   may be `undefined`, and `sources.name` / `sources.icon` report which layer
 *   won (`'env'`, `'preferences'`, or `'default'`).
 * @throws when an environment override is present but unusable, so a typo is
 *   reported instead of silently falling back.
 */
export function resolveBranding(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? PROJECT_ROOT;
  const preferences =
    options.preferences ?? new BrandingPreferences(userDataDirectory(env)).read();
  const manifest = readManifest(root);

  let name;
  let nameSource;
  if (env.DSH_DESKTOP_APP_NAME !== undefined) {
    name = normaliseName(env.DSH_DESKTOP_APP_NAME);
    nameSource = 'env';
  } else if (preferences.name !== undefined) {
    name = preferences.name;
    nameSource = 'preferences';
  } else {
    name = normaliseName(manifest.productName ?? FALLBACK_NAME);
    nameSource = 'default';
  }

  const bundleId = env.DSH_DESKTOP_BUNDLE_ID ?? manifest.dshDesktop?.bundleId ?? DEFAULT_BUNDLE_ID;
  if (!/^[A-Za-z0-9.-]+$/u.test(bundleId)) {
    throw new Error(`dsh-desktop: invalid bundle identifier ${JSON.stringify(bundleId)}`);
  }

  const sources = { name: nameSource, icon: 'default' };
  const envIcon = env.DSH_DESKTOP_ICON;
  if (envIcon !== undefined && envIcon.length > 0) {
    const path = isAbsolute(envIcon) ? envIcon : resolve(root, envIcon);
    if (!existsSync(path)) throw new Error(`dsh-desktop: DSH_DESKTOP_ICON not found: ${path}`);
    if (!ICON_EXTENSIONS.includes(extname(path).toLowerCase())) {
      throw new Error(`dsh-desktop: DSH_DESKTOP_ICON must be a .png or .icns file: ${path}`);
    }
    sources.icon = 'env';
    return { name, bundleId, ...splitIcon(path), sources };
  }

  if (preferences.icon !== undefined) {
    sources.icon = 'preferences';
    return { name, bundleId, ...splitIcon(preferences.icon), sources };
  }

  return {
    name,
    bundleId,
    iconPng: existingOrUndefined(join(root, 'assets', 'icon.png')),
    iconIcns: existingOrUndefined(join(root, 'assets', 'icon.icns')),
    sources,
  };
}

/**
 * @param path - one icon file.
 * @returns `{ iconPng, iconIcns }` with the other slot empty.
 */
function splitIcon(path) {
  return extname(path).toLowerCase() === '.png'
    ? { iconPng: path, iconIcns: undefined }
    : { iconPng: undefined, iconIcns: path };
}

/**
 * @param root - project root.
 * @returns the parsed package.json, or an empty object when unreadable.
 */
function readManifest(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param path - candidate file.
 * @returns `path` when it exists, otherwise `undefined`.
 */
function existingOrUndefined(path) {
  return existsSync(path) ? path : undefined;
}
