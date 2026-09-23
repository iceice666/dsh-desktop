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
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Resolve a DSH package from the installed harness.
 *
 * The desktop app deliberately does not vendor its own harness copy: it drives
 * the same installation the `dsh` CLI uses, so profiles, credentials, and
 * installed plugins are shared.
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
function harnessResolutionPaths(anchor) {
  const paths = [anchor];
  try {
    const entry = require.resolve('@deepseek-ai/dsh/lib/profile-boot.js', { paths: [anchor] });
    paths.push(dirname(entry));
  } catch {
    // Leave the anchor alone; the caller's own resolution reports the failure.
  }
  return paths;
}

/**
 * Start the profile tree and return the live root Context.
 *
 * @param options - `{ profile, anchor, port, log }`.
 * @returns `{ ctx, shutdown, dispose }` for the live generation.
 */
export async function startHost(options) {
  const { profile, anchor, port, log } = options;

  const paths = harnessResolutionPaths(anchor);
  const { runProfile } = await importHarness('@deepseek-ai/dsh/lib/profile-boot.js', paths);
  const { loadLayeredEnv } = await importHarness('@deepseek-ai/dsh-app-boot', paths);

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
    args: ['--no-open', '--port', String(port ?? 0)],
    patchFiles: [],
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
