/**
 * Boot the profile and issue real HTTP requests against its loopback origin, to
 * separate "the host does not serve" from "Electron cannot navigate".
 *
 * Usage: DSH_HOME=... node scripts/probe-http.mjs
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { findHarnessAnchor } from '../src/main/find-harness.js';

const require = createRequire(import.meta.url);
const { anchor } = findHarnessAnchor();

const launcher = require.resolve('@deepseek-ai/dsh/lib/profile-boot.js', { paths: [anchor] });
// Dependencies resolve from where `dsh` lives, not from the anchor.
const bootPath = require.resolve('@deepseek-ai/dsh-app-boot', {
  paths: [anchor, dirname(launcher)],
});
const { runProfile } = await import(`file://${launcher}`);
const { loadLayeredEnv } = await import(`file://${bootPath}`);

const started = await runProfile({
  profile: process.env.DSH_DESKTOP_PROFILE ?? 'web',
  args: ['--no-open', '--port', '0'],
  patchFiles: [],
  environment: loadLayeredEnv('dsh-desktop', process.cwd(), () => {}),
});

const ctx = started.ctx;
const webServer = ctx.get('webServer');
const port = webServer.listenedPort ?? webServer.port;
const origin = `http://127.0.0.1:${String(port)}`;
console.log('probe: origin =', origin);

for (const path of ['/', '/favicon.svg']) {
  try {
    const res = await fetch(`${origin}${path}`, { redirect: 'manual' });
    const body = res.status === 200 ? await res.text() : '';
    console.log(
      `probe: GET ${path} -> ${String(res.status)}`,
      res.status === 200 ? `(${String(body.length)} bytes)` : `location=${res.headers.get('location') ?? '-'}`,
    );
  } catch (error) {
    console.log(`probe: GET ${path} -> THREW ${String(error)}`);
  }
}

await ctx.fiber.dispose();
console.log('probe: disposed');
process.exit(0);
