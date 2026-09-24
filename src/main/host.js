/**
 * Boot the DSH Cordis host tree inside the Electron main process.
 *
 * This mirrors `runProfile` from `@deepseek-ai/dsh` but keeps the tree in this
 * process instead of owning a CLI lifecycle: no SIGINT handling, no browser
 * handoff. The webserver row binds loopback exactly as it does under `dsh web`,
 * so the `/plugins` bundle route, the `/api` channel, the Remote stream
 * WebSocket, and every feature Fetch route keep working unmodified. The desktop
 * adds no transport of its own.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { PROJECT_ROOT } from './branding.js';
import { DESKTOP_PROFILE_NAME, resolveDesktopProfile } from './desktop-profile.js';

const require = createRequire(import.meta.url);

/** Overlay inserting the desktop's own plugins into whatever profile boots. */
export const DESKTOP_PATCH_FILE = join(PROJECT_ROOT, 'plugins', 'cordis.patch.yml');

/**
 * Resolve a DSH package from the harness installation in use.
 *
 * Under pnpm the top-level anchor exposes only `@deepseek-ai/dsh` itself; its
 * dependencies live in the content-addressed store and are reachable only from
 * the `dsh` package's own directory. Resolution therefore tries the anchor
 * first and then where `dsh` actually lives.
 *
 * @param specifier - package subpath to resolve.
 * @param paths - resolution roots, in priority order.
 * @returns the resolved module namespace.
 */
async function importHarness(specifier, paths) {
  const resolved = require.resolve(specifier, { paths });
  return import(`file://${resolved}`);
}

/**
 * Build the resolution roots for one harness installation.
 *
 * @param anchor - node_modules directory exposing `@deepseek-ai/dsh`.
 * @returns the anchor, followed by the directory `dsh` itself occupies.
 */
export function harnessResolutionPaths(anchor) {
  const paths = [anchor];
  try {
    const entry = require.resolve('@deepseek-ai/dsh/lib/profile-boot.js', { paths: [anchor] });
    paths.push(dirname(entry));
    // `yaml` is a dependency of the settings store, not of `dsh` itself, so
    // under pnpm it resolves only from there.
    const settings = require.resolve('@deepseek-ai/dsh-settings-file', { paths: [dirname(entry)] });
    paths.push(dirname(settings));
  } catch {
    // Leave the anchor alone; the caller's own resolution reports the failure.
  }
  return paths;
}

/**
 * Load the harness's YAML library, for the legacy-home migration.
 * @param anchor - node_modules directory exposing `@deepseek-ai/dsh`.
 * @returns the `yaml` module namespace.
 */
export async function importHarnessYaml(anchor) {
  return importHarness('yaml', harnessResolutionPaths(anchor));
}

/**
 * Start the profile tree and return the live root Context.
 *
 * The `desktop` profile is application-owned: it is created and loaded here
 * from `home` and booted as a resolved profile, so the CLI's shared module
 * index is never written (see desktop-profile.js). Any other name boots a CLI
 * profile exactly as `dsh --profile <name>` would.
 *
 * @param options - `{ profile, home, anchor, port, log, extraPatchFiles }`.
 * @returns `{ ctx, shutdown, dispose }` for the live generation.
 */
export async function startHost(options) {
  const { profile, home, anchor, port, log, extraPatchFiles = [] } = options;

  const paths = harnessResolutionPaths(anchor);
  const { runProfile } = await importHarness('@deepseek-ai/dsh/lib/profile-boot.js', paths);
  const appBoot = await importHarness('@deepseek-ai/dsh-app-boot', paths);
  const { loadLayeredEnv } = appBoot;

  const resolvedProfile =
    profile === DESKTOP_PROFILE_NAME
      ? resolveDesktopProfile({
          appBoot,
          home,
          installAnchor: require.resolve('@deepseek-ai/dsh/package.json', { paths }),
        })
      : undefined;
  if (resolvedProfile !== undefined) log(`profile directory ${resolvedProfile.profile.dir}`);

  // The launch-environment snapshot is a layered object with `get`/`getFrom`,
  // not a plain record: `http-proxy` and other rows call `env.get(name)` during
  // boot. Build it with the launcher's own loader rather than hand-rolling one.
  const environment = loadLayeredEnv('dsh-desktop', process.cwd(), (line) => {
    log(`env: ${line}`);
  });

  log(`booting profile "${profile}"`);

  // `--no-open` keeps the web-runtime row from handing the authenticated URL to
  // the system browser: the desktop window is the surface. `--port 0` lets the
  // OS assign a free loopback port, so the app never collides with a `dsh web`
  // the user already has running.
  const started = await runProfile({
    profile,
    resolvedProfile,
    args: ['--no-open', '--port', String(port ?? 0)],
    // Desktop-only rows (the branding Settings page) arrive as an overlay, so
    // the user's profile on disk is never edited.
    patchFiles: [DESKTOP_PATCH_FILE, ...extraPatchFiles],
    environment,
  });

  log('profile tree is live');

  return {
    ctx: started.ctx,
    shutdown: started.shutdown,
    async dispose() {
      await started.ctx.fiber.dispose();
    },
  };
}

/**
 * Resolve the loopback origin the host is serving.
 *
 * `config.port` is the requested value — 0 when the OS assigns — while
 * `listenedPort` carries the port actually bound.
 *
 * @param ctx - booted root Context.
 * @returns absolute HTTP origin, e.g. `http://127.0.0.1:61530`.
 */
export function resolveOrigin(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    throw new Error('dsh-desktop: the profile did not mount a webServer row');
  }
  const port = webServer.listenedPort ?? webServer.port;
  if (port === undefined || port === 0) {
    throw new Error('dsh-desktop: the webServer row exposed no bound port');
  }
  const host = webServer.config?.host ?? '127.0.0.1';
  const authority = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${authority}:${String(port)}`;
}

/**
 * Build the tokenized URL used for the session admission exchange.
 *
 * `authorizeIndex` guards every index response: a clean `GET /` without the
 * launch token or a valid cookie is answered 401 before any bytes are read.
 * `authenticatedUrl` appends this process's token, which the host accepts
 * exactly once on `GET /`, answering with an authority-bound signed cookie and
 * a redirect to clean `/`.
 *
 * @param ctx - booted root Context.
 * @param origin - carrier origin from {@link resolveOrigin}.
 * @returns the tokenized root URL.
 */
export function resolveAuthenticationUrl(ctx, origin) {
  const connection = ctx.get('connection');
  if (connection === undefined) {
    throw new Error('dsh-desktop: the profile did not mount a connection row');
  }
  return connection.authenticatedUrl(origin);
}
