/**
 * Build a self-contained, ad-hoc signed `.app` for Apple Silicon.
 *
 *   dist/<Name>.app/Contents/
 *     MacOS/Electron                         stock Electron 43.0.0, unchanged
 *     Resources/app/                         package.json, src/, plugins/, assets/
 *     Resources/app/runtime/node_modules/    the DSH harness, installed from runtime/
 *
 * The harness is installed fresh from `runtime/pnpm-lock.yaml` with pnpm's
 * hoisted linker, so the tree inside the bundle is plain directories that do
 * not point back into a pnpm store and survive the app being moved. It is not
 * packed into an asar: DSH resolves and spawns files by real path (native
 * addons, node-pty's spawn-helper, ripgrep, worker scripts).
 *
 * Steps: stage the harness → assemble the bundle → stamp Info.plist and icon
 * → sign ad hoc → verify. `--smoke` then launches the packaged app once with a
 * throwaway userData and DSH home and waits for the client to mount.
 *
 * Usage: node scripts/package.mjs [options]
 *   --skip-install             reuse .build/runtime from the previous run
 *   --smoke                    launch the result and verify the client mounts
 *
 * Options used by the Nix build (nix/package.nix), which supplies every input
 * itself and has no network or pnpm store:
 *   --electron-app <path>      stock Electron.app to start from, instead of
 *                              node_modules/electron
 *   --runtime-modules <path>   an already installed hoisted harness
 *                              node_modules, instead of installing runtime/
 *   --out <dir>                output directory, instead of dist/
 *   --managed-by <owner>       record who owns the bundle; the app then never
 *                              restamps or renames itself (see packaged.js)
 *
 * Name and icon come from package.json and assets/, or DSH_DESKTOP_APP_NAME /
 * DSH_DESKTOP_ICON / DSH_DESKTOP_BUNDLE_ID when set.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveBranding, PROJECT_ROOT } from '../src/main/branding.js';
import { stampBundle, stockElectronExecutable } from '../src/main/branded-bundle.js';
import { MANAGED_BY_KEY, readBundleKey } from '../src/main/packaged.js';
import { signAdHoc } from '../src/main/relaunch.js';

const { values: options } = parseArgs({
  options: {
    smoke: { type: 'boolean', default: false },
    'skip-install': { type: 'boolean', default: false },
    'electron-app': { type: 'string' },
    'runtime-modules': { type: 'string' },
    out: { type: 'string' },
    'managed-by': { type: 'string' },
  },
  strict: true,
});
const smoke = options.smoke;
const skipInstall = options['skip-install'];

/** Electron build the bundled harness's native module accepts; see README. */
const REQUIRED_ELECTRON = '43.0.0';

const BUILD_DIRECTORY = join(PROJECT_ROOT, '.build');
const STAGED_RUNTIME = join(BUILD_DIRECTORY, 'runtime');
const OUTPUT_DIRECTORY = options.out === undefined ? join(PROJECT_ROOT, 'dist') : resolve(options.out);

/** What of this project goes into Resources/app. Everything else stays behind. */
const APP_CONTENT = ['src', 'plugins', 'assets'];

/**
 * @param message - progress line.
 */
function step(message) {
  process.stdout.write(`\n── ${message}\n`);
}

/**
 * Run a command, inheriting output, and fail loudly.
 * @param command - executable.
 * @param argv - arguments.
 * @param options - spawn options.
 */
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`package: ${command} ${argv.join(' ')} exited with ${String(result.status ?? result.signal)}`);
  }
}

// ── preflight ────────────────────────────────────────────────────────────────

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('package: only macOS on Apple Silicon is supported (the harness ships darwin-arm64 binaries)');
}

const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
let stockApp;
let electronVersion;
if (options['electron-app'] === undefined) {
  stockApp = dirname(dirname(dirname(stockElectronExecutable())));
  electronVersion = JSON.parse(
    readFileSync(createRequire(import.meta.url).resolve('electron/package.json'), 'utf8'),
  ).version;
} else {
  stockApp = resolve(options['electron-app']);
  electronVersion = readBundleKey(stockApp, 'CFBundleVersion');
}
if (electronVersion !== REQUIRED_ELECTRON) {
  throw new Error(`package: ${stockApp} is Electron ${String(electronVersion)}; the harness needs exactly ${REQUIRED_ELECTRON}`);
}

// Packaging must be reproducible: identity comes from package.json and
// assets/ (or an explicit env override), never from this machine's Settings.
const branding = resolveBranding({ preferences: {} });
const version = manifest.version;
const app = join(OUTPUT_DIRECTORY, `${branding.name}.app`);
const resources = join(app, 'Contents', 'Resources');
const appRoot = join(resources, 'app');

// ── 1. harness ───────────────────────────────────────────────────────────────

let stagedModules = join(STAGED_RUNTIME, 'node_modules');
if (options['runtime-modules'] !== undefined) {
  stagedModules = resolve(options['runtime-modules']);
  step(`harness: using ${stagedModules}`);
} else if (skipInstall && existsSync(join(stagedModules, '@deepseek-ai', 'dsh'))) {
  step('harness: reusing .build/runtime');
} else {
  step('harness: installing runtime/ (hoisted, production, frozen lockfile)');
  rmSync(STAGED_RUNTIME, { recursive: true, force: true });
  mkdirSync(STAGED_RUNTIME, { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    cpSync(join(PROJECT_ROOT, 'runtime', file), join(STAGED_RUNTIME, file));
  }
  run('pnpm', ['install', '--frozen-lockfile', '--prod', '--config.confirmModulesPurge=false'], {
    cwd: STAGED_RUNTIME,
    // Keep the build independent of whatever the caller's shell selected.
    env: { ...process.env, npm_config_node_linker: 'hoisted' },
  });
}

const dshVersion = JSON.parse(
  readFileSync(join(stagedModules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
).version;

// ── 2. bundle ────────────────────────────────────────────────────────────────

step(`bundle: ${app}`);
rmSync(app, { recursive: true, force: true });
mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
// `ditto` preserves the framework symlinks and extended attributes Electron's
// helpers rely on.
run('ditto', [stockApp, app]);
// The stock default app would otherwise load when Resources/app is missing.
rmSync(join(resources, 'default_app.asar'), { force: true });

mkdirSync(appRoot, { recursive: true });
for (const entry of APP_CONTENT) {
  cpSync(join(PROJECT_ROOT, entry), join(appRoot, entry), { recursive: true });
}
// A trimmed manifest: the fields the app reads at runtime, nothing about
// scripts or dev dependencies.
writeFileSync(
  join(appRoot, 'package.json'),
  `${JSON.stringify(
    {
      name: manifest.name,
      // The resolved name, so an override (DSH_DESKTOP_APP_NAME, or the Nix
      // module's `name`) becomes this bundle's default at runtime too.
      productName: branding.name,
      version,
      private: true,
      type: manifest.type,
      main: manifest.main,
      dshDesktop: { ...manifest.dshDesktop, bundleId: branding.bundleId },
    },
    null,
    2,
  )}\n`,
);

// Likewise an overriding icon replaces the shipped default inside the bundle.
if (branding.sources.icon === 'env') {
  for (const file of ['icon.png', 'icon.icns']) rmSync(join(appRoot, 'assets', file), { force: true });
  const icon = branding.iconIcns ?? branding.iconPng;
  cpSync(icon, join(appRoot, 'assets', branding.iconIcns === undefined ? 'icon.png' : 'icon.icns'));
}

step('bundle: copying harness');
// Hidden pnpm bookkeeping (.pnpm, .modules.yaml) and .bin shims are useless
// inside the bundle; the .bin entries are symlinks to relative paths anyway.
const runtimeModules = join(appRoot, 'runtime', 'node_modules');
mkdirSync(dirname(runtimeModules), { recursive: true });
// --noextattr --noacl: the source may be a read-only Nix build tree.
run('ditto', ['--noextattr', '--noacl', stagedModules, runtimeModules]);
run('chmod', ['-R', 'u+w', runtimeModules]);
for (const junk of ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json']) {
  rmSync(join(runtimeModules, junk), { recursive: true, force: true });
}
cpSync(join(PROJECT_ROOT, 'runtime', 'package.json'), join(appRoot, 'runtime', 'package.json'));

// What dsh-subprocess-local's skipped postinstall would have done.
const spawnHelper = join(runtimeModules, 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755);

// A symlink that escapes the bundle would dangle on every other machine.
const escaping = execFileSync(
  'find',
  [appRoot, '-type', 'l', '-exec', 'sh', '-c', 'for l; do case "$(readlink "$l")" in /*) echo "$l";; esac; done', 'sh', '{}', '+'],
  { encoding: 'utf8' },
).trim();
if (escaping.length > 0) {
  throw new Error(`package: absolute symlinks inside the bundle:\n${escaping}`);
}

// ── 3. identity ──────────────────────────────────────────────────────────────

step(`identity: ${branding.name} (${branding.bundleId}) ${version}`);
// Stamp against the bundle's own copy of assets/, so the recorded icon
// identity is the bundled default rather than a path on this machine.
// The overrides are now the bundle's defaults, so resolve without them.
const bundleEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !['DSH_DESKTOP_APP_NAME', 'DSH_DESKTOP_ICON', 'DSH_DESKTOP_BUNDLE_ID'].includes(key)),
);
stampBundle(app, resolveBranding({ root: appRoot, preferences: {}, env: bundleEnv }), {
  version,
  // A Nix build has no LaunchServices to talk to, and the copy in the store is
  // not where the user will open it from.
  register: options['managed-by'] === undefined,
});
const plist = join(app, 'Contents', 'Info.plist');
execFileSync('plutil', ['-replace', 'LSApplicationCategoryType', '-string', 'public.app-category.developer-tools', plist]);
execFileSync('plutil', ['-replace', 'DSHDesktopHarnessVersion', '-string', dshVersion, plist]);
if (options['managed-by'] !== undefined) {
  execFileSync('plutil', ['-replace', MANAGED_BY_KEY, '-string', options['managed-by'], plist]);
}

// ── 4. signature ─────────────────────────────────────────────────────────────

step('sign: ad hoc');
// Stock Electron is already ad-hoc signed, framework and helpers included; only
// the outer bundle changed. The harness under Resources is sealed as
// resources, so no --deep pass is needed.
signAdHoc(app);

// ── 5. verify ────────────────────────────────────────────────────────────────

step('verify');
run('codesign', ['--verify', '--strict', '--verbose=1', app]);
const executable = join(app, 'Contents', 'MacOS', 'Electron');
// The packaged Electron must be able to load the harness's native module —
// the whole reason Electron is pinned. Check it without opening a window.
const probe = spawnSync(
  executable,
  [
    '--input-type=module',
    '--eval',
    [
      "import { createRequire } from 'node:module';",
      `const anchor = ${JSON.stringify(runtimeModules)};`,
      'const require = createRequire(anchor + "/");',
      "const entry = require.resolve('@deepseek-ai/dsh/lib/profile-boot.js', { paths: [anchor] });",
      "await import('file://' + entry);",
      "console.log('harness loads under', process.versions.electron);",
    ].join('\n'),
  ],
  { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
);
process.stdout.write(probe.stdout);
if (probe.status !== 0) {
  process.stderr.write(probe.stderr);
  throw new Error('package: the packaged Electron cannot load the bundled harness');
}

const size = execFileSync('du', ['-sh', app], { encoding: 'utf8' }).split('\t')[0];
process.stdout.write(`\n${app}\n  ${size}, DSH ${dshVersion}, Electron ${electronVersion}, ad-hoc signed\n`);

// ── 6. smoke ─────────────────────────────────────────────────────────────────

if (smoke) {
  step('smoke: launching the packaged app');
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-desktop-package-smoke-'));
  const extraFlags = (process.env.DSH_DESKTOP_ELECTRON_FLAGS ?? '').split(' ').filter(Boolean);
  const result = spawnSync(executable, extraFlags, {
    encoding: 'utf8',
    // Launched from `/` like Finder does, with none of this shell's DSH state.
    cwd: '/',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_'))),
      DSH_DESKTOP_SMOKE: '1',
      DSH_DESKTOP_VERBOSE: '1',
      DSH_DESKTOP_USER_DATA: join(scratch, 'user-data'),
      // The app otherwise shares the real ~/.dsh with the CLI.
      DSH_DESKTOP_DSH_HOME: join(scratch, 'dsh-home'),
      ...(extraFlags.length > 0 ? { DSH_DESKTOP_ELECTRON_FLAGS: extraFlags.join(' ') } : {}),
    },
    timeout: 180_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  for (const line of output.split('\n')) {
    if (/dsh-desktop:|SMOKE|ERR_|did-fail/u.test(line)) process.stdout.write(`${line}\n`);
  }
  rmSync(scratch, { recursive: true, force: true });
  if (!output.includes('SMOKE OK')) throw new Error('package: packaged smoke FAILED');
  process.stdout.write('\npackaged smoke passed — the client mounted from the bundled harness\n');
}
