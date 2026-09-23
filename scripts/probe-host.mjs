/**
 * Boot probe: start the DSH profile tree in a plain Node process and report the
 * facts the desktop carrier depends on. Run before wiring Electron so a boot
 * failure is diagnosed without a window in the way.
 *
 * Usage: node scripts/probe-host.mjs [profile]
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { findHarnessAnchor } from '../src/main/find-harness.js';

const require = createRequire(import.meta.url);
const profile = process.argv[2] ?? 'web';
const { anchor } = findHarnessAnchor();

const resolved = require.resolve('@deepseek-ai/dsh/lib/profile-boot.js', { paths: [anchor] });
console.log('probe: resolved launcher ->', resolved);

const { runProfile } = await import(`file://${resolved}`);

// Dependencies resolve from where `dsh` lives, not from the anchor.
const bootPath = require.resolve('@deepseek-ai/dsh-app-boot', {
  paths: [anchor, dirname(resolved)],
});
const { loadLayeredEnv } = await import(`file://${bootPath}`);
const environment = loadLayeredEnv('dsh', process.cwd(), (line) => {
  console.warn('probe: env warning:', line);
});

console.log('probe: booting profile', JSON.stringify(profile));
const port = process.env.DSH_PROBE_PORT ?? '0';
const started = await runProfile({
  profile,
  args: ['--no-open', '--port', port],
  patchFiles: [],
  environment,
});

const ctx = started.ctx;
console.log('probe: tree state =', ctx.fiber.state);

for (const key of ['webServer', 'connection', 'typertGateway', 'clientModules', 'loader']) {
  const service = ctx.get(key);
  console.log(`probe: service ${key} =`, service === undefined ? 'MISSING' : 'present');
}

const webServer = ctx.get('webServer');
if (webServer !== undefined) {
  console.log('probe: webServer keys =', Object.keys(webServer).join(', '));
  for (const key of ['host', 'port', 'config', 'server']) {
    const value = webServer[key];
    if (value !== undefined && typeof value !== 'function') {
      console.log(`probe: webServer.${key} =`, JSON.stringify(value));
    }
  }
}

const gateway = ctx.get('typertGateway');
if (gateway !== undefined) {
  console.log('probe: gateway.wireStream =', typeof gateway.wireStream);
  console.log('probe: gateway.wireStream.open =', typeof gateway.wireStream?.open);
}

const connection = ctx.get('connection');
if (connection !== undefined) {
  console.log(
    'probe: connection.createSharedFetchHandler =',
    typeof connection.createSharedFetchHandler,
  );
}

const table = [];
ctx.emit('webserver/index-inject', table);
console.log('probe: injection rows =', table.length);
for (const row of table) {
  const detail =
    row.kind === 'global'
      ? row.name
      : (row.src ?? `${String(row.text?.length ?? row.html?.length ?? 0)} chars`);
  console.log(`probe:   - ${row.kind} ${String(detail)}`);
}

await ctx.fiber.dispose();
console.log('probe: disposed cleanly');
process.exit(0);
