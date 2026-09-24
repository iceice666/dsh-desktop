/**
 * Pure-logic checks for the shared DSH home, the `desktop` profile, and the
 * one-time move from the old private home. No harness, no window: the harness
 * loaders are stubbed, and settings fixtures are JSON (valid YAML), so JSON
 * stands in for the YAML library.
 *
 * Usage: node scripts/test-desktop-profile.mjs
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REQUIRED_BUNDLES,
  desktopBundleList,
  ensureDesktopProfile,
  resolveDesktopDshHome,
  resolveDesktopProfile,
} from '../src/main/desktop-profile.js';
import {
  MIGRATION_MARKER,
  legacyDshHome,
  mergeMissing,
  mergeWorkspaceStores,
  migrateLegacyHome,
} from '../src/main/home-migration.js';

let passed = 0;
const failures = [];

/**
 * @param name - assertion label.
 * @param condition - result under test.
 */
function check(name, condition) {
  if (condition === true) passed += 1;
  else failures.push(name);
}

/** @param fn - function expected to throw. @param pattern - message pattern. */
function throws(fn, pattern) {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(String(error?.message ?? error));
  }
}

/** @param path - file. */
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** @param path - file. @param value - JSON value. */
function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`);
}

/** Minimal stand-in for the harness's `@deepseek-ai/dsh-app-boot`. */
const appBoot = {
  PROFILES_DIR: 'profiles',
  initProfile(dir, bundles) {
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'package.json'), {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles } },
    });
  },
  readProfileManifest: (_bin, dir) => readJson(join(dir, 'package.json')),
  writeProfileManifest: (dir, manifest) => writeJson(join(dir, 'package.json'), manifest),
  loadProfileDirectory: (_bin, dir, anchor) => ({ dir, anchor }),
};

/** JSON is a subset of YAML, and every fixture below is JSON. */
const yaml = { parse: JSON.parse, stringify: (value) => `${JSON.stringify(value, undefined, 2)}\n` };

const scratch = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-test-'));
try {
  // ── home resolution ───────────────────────────────────────────────────────
  const home = '/Users/u';
  check('home: packaged defaults to ~/.dsh', resolveDesktopDshHome({ env: {}, packaged: true, home }).path === '/Users/u/.dsh');
  check(
    'home: packaged ignores an inherited DSH_HOME',
    resolveDesktopDshHome({ env: { DSH_HOME: '/x' }, packaged: true, home }).source === 'default',
  );
  check(
    'home: development honours DSH_HOME like the CLI',
    resolveDesktopDshHome({ env: { DSH_HOME: '/x' }, packaged: false, home }).path === '/x',
  );
  check(
    'home: DSH_DESKTOP_DSH_HOME overrides everything',
    resolveDesktopDshHome({ env: { DSH_HOME: '/x', DSH_DESKTOP_DSH_HOME: '/y' }, packaged: true, home }).path === '/y',
  );
  check(
    'home: a blank override is ignored',
    resolveDesktopDshHome({ env: { DSH_DESKTOP_DSH_HOME: '  ' }, packaged: true, home }).source === 'default',
  );

  // ── desktop profile ───────────────────────────────────────────────────────
  check(
    'bundles: required first, third-party order kept',
    JSON.stringify(desktopBundleList(['a', '@deepseek-ai/dsh-web-app', 'b'])) ===
      JSON.stringify([...REQUIRED_BUNDLES, 'a', 'b']),
  );
  const profileHome = join(scratch, 'profile-home');
  const dir = ensureDesktopProfile(appBoot, profileHome);
  check('profile: created at profiles/desktop', dir === join(profileHome, 'profiles', 'desktop'));
  check(
    'profile: initialized with the web bundles',
    JSON.stringify(readJson(join(dir, 'package.json')).dsh.profile.bundles) === JSON.stringify(REQUIRED_BUNDLES),
  );
  writeJson(join(dir, 'package.json'), { name: 'x', dependencies: { p: '1' }, dsh: { profile: { bundles: ['p'], patchReload: 'live' } } });
  ensureDesktopProfile(appBoot, profileHome);
  const repaired = readJson(join(dir, 'package.json'));
  check('profile: missing required bundles are restored', repaired.dsh.profile.bundles.join() === [...REQUIRED_BUNDLES, 'p'].join());
  check('profile: other manifest fields survive', repaired.dependencies.p === '1' && repaired.dsh.profile.patchReload === 'live');
  writeJson(join(dir, 'package.json'), { dsh: { profile: { bundles: 'nope' } } });
  check('profile: a malformed bundle list fails loudly', throws(() => ensureDesktopProfile(appBoot, profileHome), /must be an array/u));
  check(
    'profile: an old harness is reported, not crashed into',
    throws(() => resolveDesktopProfile({ appBoot: {}, home: profileHome, installAnchor: '/a' }), /DSH_DESKTOP_PROFILE=web/u),
  );

  // ── merge helpers ─────────────────────────────────────────────────────────
  const merged = mergeMissing(
    { a: 1, nested: { keep: 'base', list: [1] } },
    { a: 2, b: 3, nested: { keep: 'extra', add: true, list: [9] } },
  );
  check('settings: base wins scalars', merged.a === 1 && merged.nested.keep === 'base');
  check('settings: base wins lists whole', JSON.stringify(merged.nested.list) === '[1]');
  check('settings: missing keys are added at any depth', merged.b === 3 && merged.nested.add === true);

  const store = (rows, archived = []) => ({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: Object.keys(rows), archivedSessionIds: archived },
    tables: { workspaces: rows },
  });
  const ws = mergeWorkspaceStores(
    store({ w1: { path: '/p', sessionIds: ['s1'], updatedAt: '2026-01-01' } }),
    store(
      { w9: { path: '/p', sessionIds: ['s2', 's1'], updatedAt: '2026-02-01' }, w2: { path: '/q', sessionIds: ['s3'] } },
      ['s4'],
    ),
  );
  check('workspaces: same path merges sessions, newest first', ws.tables.workspaces.w1.sessionIds.join() === 's2,s1');
  check('workspaces: later updatedAt wins', ws.tables.workspaces.w1.updatedAt === '2026-02-01');
  check('workspaces: a new path is appended', ws.tables.workspaces.w2.path === '/q' && ws.global.workspaceIds.join() === 'w1,w2');
  check('workspaces: archived ids are unioned', ws.global.archivedSessionIds.join() === 's4');

  // ── legacy home migration ─────────────────────────────────────────────────
  const userData = join(scratch, 'user-data');
  const legacy = legacyDshHome(userData);
  const shared = join(scratch, 'shared-home');
  const legacyProfile = join(legacy, 'profiles', 'web');
  writeJson(join(legacyProfile, 'package.json'), { name: 'dsh-profile-web', dsh: { profile: { bundles: ['x'] } } });
  writeFileSync(join(legacyProfile, 'cordis.patch.yml'), '- id: web\n');
  writeFileSync(join(legacyProfile, 'cordis.yml'), '[]\n');
  mkdirSync(join(legacyProfile, 'node_modules', 'plugin'), { recursive: true });
  writeFileSync(join(legacyProfile, 'node_modules', 'plugin', 'index.js'), '');
  writeFileSync(join(legacyProfile, 'node_modules', '.pnpm-workspace-state-v1.json'), '{}');
  mkdirSync(join(legacy, 'sessions', 'proj', 'session-new'), { recursive: true });
  writeFileSync(join(legacy, 'sessions', 'proj', 'session-new', 'log'), 'legacy');
  mkdirSync(join(legacy, 'sessions', 'proj', 'session-both'), { recursive: true });
  writeFileSync(join(legacy, 'sessions', 'proj', 'session-both', 'log'), 'legacy');
  writeJson(join(legacy, 'storages', 'session_projcache', 'sessions', 'session-new.json'), {});
  writeJson(join(legacy, 'storages', 'workspace.json'), store({ w9: { path: '/p', sessionIds: ['session-new'] } }));
  writeJson(join(legacy, 'settings.yaml'), { model: 'legacy', extra: { key: 1 } });
  writeFileSync(join(legacy, '.credentials.yaml'), 'secret');
  symlinkSync('/nonexistent/legacy-env', join(legacy, '.env'));

  mkdirSync(join(shared, 'sessions', 'proj', 'session-both'), { recursive: true });
  writeFileSync(join(shared, 'sessions', 'proj', 'session-both', 'log'), 'shared');
  writeJson(join(shared, 'storages', 'workspace.json'), store({ w1: { path: '/p', sessionIds: ['s1'] } }));
  writeJson(join(shared, 'settings.yaml'), { model: 'shared' });

  const done = migrateLegacyHome({ legacy, home: shared, yaml, now: new Date('2026-09-24T00:00:00Z') });
  const moved = join(shared, 'profiles', 'desktop');
  check('migrate: reports what it did', done.length >= 5);
  check('migrate: web profile becomes the desktop profile', readJson(join(moved, 'package.json')).name === 'dsh-profile-desktop');
  check('migrate: bundles and patch layer carried over', readJson(join(moved, 'package.json')).dsh.profile.bundles[0] === 'x' && existsSync(join(moved, 'cordis.patch.yml')));
  check('migrate: installed plugins carried over', existsSync(join(moved, 'node_modules', 'plugin', 'index.js')));
  check('migrate: location-bound files are dropped', !existsSync(join(moved, 'cordis.yml')) && !existsSync(join(moved, 'node_modules', '.pnpm-workspace-state-v1.json')));
  check('migrate: no staging directory left', !readdirSync(join(shared, 'profiles')).some((name) => name.includes('migrating')));
  check('migrate: new sessions copied', readFileSync(join(shared, 'sessions', 'proj', 'session-new', 'log'), 'utf8') === 'legacy');
  check('migrate: existing sessions never overwritten', readFileSync(join(shared, 'sessions', 'proj', 'session-both', 'log'), 'utf8') === 'shared');
  check('migrate: projection caches copied', existsSync(join(shared, 'storages', 'session_projcache', 'sessions', 'session-new.json')));
  check('migrate: workspace sessions merged', readJson(join(shared, 'storages', 'workspace.json')).tables.workspaces.w1.sessionIds.join() === 'session-new,s1');
  const settings = readJson(join(shared, 'settings.yaml'));
  check('migrate: shared settings win', settings.model === 'shared' && settings.extra.key === 1);
  check('migrate: settings backup kept', readdirSync(shared).some((name) => name.startsWith('settings.yaml.pre-desktop-migration-')));
  check('migrate: env symlink carried over verbatim', lstatSync(join(shared, '.env')).isSymbolicLink() && readlinkSync(join(shared, '.env')) === '/nonexistent/legacy-env');
  check('migrate: install-bound credentials stay behind', !existsSync(join(shared, '.credentials.yaml')));
  check('migrate: old home is marked, not deleted', existsSync(join(legacy, MIGRATION_MARKER)) && existsSync(legacyProfile));
  check('migrate: a second run does nothing', migrateLegacyHome({ legacy, home: shared, yaml }).length === 0);

  const fresh = join(scratch, 'fresh');
  mkdirSync(join(fresh, 'legacy', 'profiles', 'web'), { recursive: true });
  writeJson(join(fresh, 'legacy', 'profiles', 'web', 'package.json'), { name: 'dsh-profile-web' });
  mkdirSync(join(fresh, 'home', 'profiles', 'desktop'), { recursive: true });
  writeFileSync(join(fresh, 'home', '.env'), 'KEEP=1\n');
  writeFileSync(join(fresh, 'legacy', '.env'), 'OLD=1\n');
  const kept = migrateLegacyHome({ legacy: join(fresh, 'legacy'), home: join(fresh, 'home'), yaml });
  check('migrate: an existing desktop profile is kept', kept.includes('kept existing profiles/desktop'));
  check('migrate: a working .env is never replaced', readFileSync(join(fresh, 'home', '.env'), 'utf8') === 'KEEP=1\n');
  check('migrate: no legacy home, nothing to do', migrateLegacyHome({ legacy: join(fresh, 'absent'), home: join(fresh, 'home'), yaml }).length === 0);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAILED (${String(failures.length)}):\n${failures.map((name) => `  - ${name}`).join('\n')}`);
  process.exit(1);
}
console.log(`ok — ${String(passed)} assertions passed`);
