/**
 * PTC probe: run one Node PTC program through the host tree from inside a real
 * Electron main process, the way the packaged app does.
 *
 * `dsh-ptc-runtime-node` spawns `process.execPath` to run programs. Under plain
 * Node that is `node`; inside Electron it is the Electron executable, which
 * only behaves as Node when `ELECTRON_RUN_AS_NODE=1` reaches the child — and
 * the runtime deliberately strips that variable from the child environment.
 * This probe shows whether a program actually runs.
 *
 * Usage: electron scripts/probe-ptc.mjs   (DSH_ANCHOR / DSH_HOME as for the app)
 */

import { app } from 'electron';

import { findHarnessAnchor } from '../src/main/find-harness.js';
import { startHost } from '../src/main/host.js';
import { installNodeShim } from '../src/main/node-shim.js';

app.dock?.hide();

// No top-level await before `ready`: Electron holds the `ready` event until an
// ESM entry's top-level await settles, so awaiting it here would deadlock.
app.whenReady().then(async () => {
let host;
let code = 1;
try {
  const { anchor } = findHarnessAnchor();
  // DSH_PROBE_NO_SHIM=1 reproduces the unfixed failure.
  const extraPatchFiles = process.env.DSH_PROBE_NO_SHIM === '1'
    ? []
    : [installNodeShim({ userData: app.getPath('userData'), executable: process.execPath }).overlay];
  host = await startHost({ profile: 'web', anchor, port: 0, log: () => {}, extraPatchFiles });
  const ptc = host.ctx.get('ptcRuntime');
  if (ptc === undefined) throw new Error('profile mounted no ptcRuntime');
  console.log('probe: execPath =', process.execPath);
  console.log('probe: nodeExecutable =', ptc.config.nodeExecutable);
  const result = await ptc.run({
    program: 'return process.versions.node + " electron=" + String(process.versions.electron)',
    bindings: [],
    cwd: process.cwd(),
    timeoutMs: 20_000,
    sandboxPolicy: { mode: 'danger-full-access' },
  });
  console.log('probe: result =', JSON.stringify(result).slice(0, 600));
  code = typeof result?.value === 'string' && result.value.includes('electron=') ? 0 : 2;
} catch (error) {
  console.log('probe: error =', error?.stack ?? String(error));
} finally {
  await host?.dispose().catch(() => {});
  app.exit(code);
}
});
