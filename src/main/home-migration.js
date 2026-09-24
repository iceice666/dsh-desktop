/**
 * One-time move from the app's former private DSH home to the shared one.
 *
 * Earlier builds kept DSH state in `<userData>/dsh-home` and booted a `web`
 * profile there. The app now shares `~/.dsh` with the CLI and boots the
 * reserved `desktop` profile (see desktop-profile.js). On the first launch that
 * finds the old home, this copies what belongs to the user into the new one:
 *
 * - `profiles/web` becomes `profiles/desktop` (installed plugins, lockfile,
 *   and the profile patch layer), unless a desktop profile already exists;
 * - sessions, session projection caches, observational memory, and
 *   attachments are copied where the shared home does not already hold them;
 * - `storages/workspace.json` is merged by workspace path;
 * - `settings.yaml` is deep-merged with the shared home winning every
 *   conflict, after a backup of the original;
 * - `.env` is carried over only when the shared home has none that resolves.
 *
 * Nothing is overwritten or deleted. `.credentials.yaml` holds only this
 * install's browser-session secret and `.anonymous-user-id` an install id, so
 * both are left behind. The old home stays in place with a marker file naming
 * where it went, which also keeps the migration from running twice.
 *
 * Like `branding.js`, this module imports nothing from Electron.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { DESKTOP_PROFILE_NAME } from './desktop-profile.js';

/** Marker written into the old home once its data has been copied. */
export const MIGRATION_MARKER = '.migrated-to';

/** Profile the old home booted. */
const LEGACY_PROFILE_NAME = 'web';

/** Profile files that are regenerated or tied to the old location. */
const PROFILE_SKIP = new Set(['cordis.yml', '.dsh-module-fallback', '.pnpm-workspace-state-v1.json']);

/**
 * The old private home.
 * @param userData - the app's userData directory.
 * @returns absolute path.
 */
export function legacyDshHome(userData) {
  return join(userData, 'dsh-home');
}

/**
 * Whether a path exists, following symlinks.
 * @param path - absolute path.
 */
function resolves(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether anything (including a dangling symlink) sits at a path.
 * @param path - absolute path.
 */
function occupied(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file atomically beside its destination.
 * @param path - destination.
 * @param text - contents.
 * @param mode - file mode.
 */
function writeAtomic(path, text, mode = 0o600) {
  const temporary = `${path}.dsh-desktop-${String(process.pid)}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

/**
 * Copy every entry of `from` that `to` lacks, recursing into directories that
 * exist on both sides. Existing files are never replaced.
 *
 * @param from - source directory.
 * @param to - destination directory.
 * @param skip - entry names to ignore at every level.
 * @returns number of top-level-or-nested entries copied.
 */
function copyMissing(from, to, skip = new Set()) {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (occupied(target)) {
        copied += copyMissing(source, target, skip);
      } else {
        cpSync(source, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
        copied += 1;
      }
    } else if (!occupied(target)) {
      if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
      else cpSync(source, target, { preserveTimestamps: true });
      copied += 1;
    }
  }
  return copied;
}

/**
 * Deep-merge `extra` under `base`: maps merge recursively, and for every other
 * value (scalars and lists alike) `base` wins when it has the key.
 *
 * @param base - authoritative mapping.
 * @param extra - mapping supplying only what `base` lacks.
 * @returns a new merged mapping.
 */
export function mergeMissing(base, extra) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in merged)) {
      merged[key] = value;
    } else if (isMapping(merged[key]) && isMapping(value)) {
      merged[key] = mergeMissing(merged[key], value);
    }
  }
  return merged;
}

/** @param value - anything. */
function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge one workspace store into another, matching workspaces by path.
 *
 * @param base - destination store (`storages/workspace.json`), or undefined.
 * @param extra - legacy store.
 * @returns the merged store.
 */
export function mergeWorkspaceStores(base, extra) {
  if (base === undefined) return structuredClone(extra);
  const merged = structuredClone(base);
  merged.global ??= {};
  merged.global.workspaceIds ??= [];
  merged.global.archivedSessionIds ??= [];
  merged.tables ??= {};
  merged.tables.workspaces ??= {};

  const byPath = new Map(Object.entries(merged.tables.workspaces).map(([id, row]) => [row.path, id]));
  for (const [id, row] of Object.entries(extra.tables?.workspaces ?? {})) {
    const existing = byPath.get(row.path);
    if (existing === undefined) {
      const newId = id in merged.tables.workspaces ? `${id}-migrated` : id;
      merged.tables.workspaces[newId] = structuredClone(row);
      merged.global.workspaceIds.push(newId);
      byPath.set(row.path, newId);
      continue;
    }
    const target = merged.tables.workspaces[existing];
    const sessions = new Set(target.sessionIds ?? []);
    const added = (row.sessionIds ?? []).filter((session) => !sessions.has(session));
    // Workspace session lists run newest first.
    target.sessionIds = [...added, ...(target.sessionIds ?? [])];
    if ((row.updatedAt ?? '') > (target.updatedAt ?? '')) target.updatedAt = row.updatedAt;
  }
  const archived = new Set(merged.global.archivedSessionIds);
  for (const session of extra.global?.archivedSessionIds ?? []) {
    if (!archived.has(session)) merged.global.archivedSessionIds.push(session);
  }
  return merged;
}

/**
 * Move the old profile to `profiles/desktop` in the new home.
 * @returns a description, or undefined when nothing was done.
 */
function migrateProfile(legacy, home) {
  const from = join(legacy, 'profiles', LEGACY_PROFILE_NAME);
  const to = join(home, 'profiles', DESKTOP_PROFILE_NAME);
  if (!existsSync(join(from, 'package.json'))) return undefined;
  if (occupied(to)) return `kept existing profiles/${DESKTOP_PROFILE_NAME}`;
  mkdirSync(dirname(to), { recursive: true });
  // Stage beside the destination and rename, so a failed copy never leaves a
  // half-populated profile for the next boot to load.
  const staging = `${to}.dsh-desktop-migrating`;
  cpSync(from, staging, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    filter: (source) => !PROFILE_SKIP.has(source.slice(source.lastIndexOf('/') + 1)),
  });
  const manifestPath = join(staging, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = `dsh-profile-${DESKTOP_PROFILE_NAME}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  renameSync(staging, to);
  return `profiles/${LEGACY_PROFILE_NAME} → profiles/${DESKTOP_PROFILE_NAME}`;
}

/** Merge legacy settings under the shared ones. */
function migrateSettings(legacy, home, yaml, stamp) {
  const from = join(legacy, 'settings.yaml');
  const to = join(home, 'settings.yaml');
  if (!existsSync(from)) return undefined;
  const extra = yaml.parse(readFileSync(from, 'utf8')) ?? {};
  if (!isMapping(extra)) return 'skipped settings.yaml (not a mapping)';
  if (!existsSync(to)) {
    copyFileSync(from, to);
    return 'copied settings.yaml';
  }
  if (lstatSync(to).isSymbolicLink()) return 'kept symlinked settings.yaml';
  const original = readFileSync(to, 'utf8');
  const base = yaml.parse(original) ?? {};
  if (!isMapping(base)) return 'kept settings.yaml (not a mapping)';
  const merged = mergeMissing(base, extra);
  if (JSON.stringify(merged) === JSON.stringify(base)) return undefined;
  writeFileSync(`${to}.pre-desktop-migration-${stamp}`, original, { mode: 0o600 });
  writeAtomic(to, yaml.stringify(merged));
  return 'merged settings.yaml (backup kept)';
}

/** Merge the workspace store. */
function migrateWorkspaces(legacy, home, stamp) {
  const from = join(legacy, 'storages', 'workspace.json');
  const to = join(home, 'storages', 'workspace.json');
  if (!existsSync(from)) return undefined;
  const extra = JSON.parse(readFileSync(from, 'utf8'));
  const original = existsSync(to) ? readFileSync(to, 'utf8') : undefined;
  const merged = mergeWorkspaceStores(original === undefined ? undefined : JSON.parse(original), extra);
  const text = `${JSON.stringify(merged, undefined, 2)}\n`;
  if (text === original) return undefined;
  mkdirSync(dirname(to), { recursive: true });
  if (original !== undefined) writeFileSync(`${to}.pre-desktop-migration-${stamp}`, original, { mode: 0o600 });
  writeAtomic(to, text);
  return 'merged storages/workspace.json';
}

/** Carry `.env` over when the shared home has none that resolves. */
function migrateEnv(legacy, home) {
  const from = join(legacy, '.env');
  const to = join(home, '.env');
  if (!occupied(from) || resolves(to)) return undefined;
  if (occupied(to)) renameSync(to, `${to}.dangling`);
  if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else copyFileSync(from, to);
  return 'carried over .env';
}

/**
 * Copy the old private home into the shared one, once.
 *
 * @param options - `{ legacy, home, yaml, log, now }`. `yaml` provides
 *   `parse`/`stringify` (the harness's `yaml` package).
 * @returns list of what was done; empty when there was nothing to migrate.
 */
export function migrateLegacyHome(options) {
  const { legacy, home, yaml, log = () => {}, now = new Date() } = options;
  if (!existsSync(legacy) || existsSync(join(legacy, MIGRATION_MARKER))) return [];
  if (resolve(legacy) === resolve(home)) return [];
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replaceAll(/[:.]/gu, '-');

  const done = [];
  const record = (line) => {
    if (line !== undefined) {
      done.push(line);
      log(`migration: ${line}`);
    }
  };

  record(migrateProfile(legacy, home));
  for (const directory of ['sessions', 'observational-memory', 'attachments']) {
    const copied = copyMissing(join(legacy, directory), join(home, directory));
    if (copied > 0) record(`copied ${String(copied)} entries of ${directory}/`);
  }
  const caches = copyMissing(join(legacy, 'storages'), join(home, 'storages'), new Set(['workspace.json']));
  if (caches > 0) record(`copied ${String(caches)} entries of storages/`);
  record(migrateWorkspaces(legacy, home, stamp));
  record(migrateSettings(legacy, home, yaml, stamp));
  record(migrateEnv(legacy, home));

  writeFileSync(
    join(legacy, MIGRATION_MARKER),
    `${home}\n# Migrated ${now.toISOString()} by dsh-desktop. This directory is no longer read;\n# delete it once the app works from the path above.\n`,
  );
  return done;
}
