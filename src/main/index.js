/**
 * Electron main process: own the DSH host tree and one desktop shell generation.
 *
 * The renderer runs the stock upstream web client against the host's own
 * loopback carrier. No Electron API is exposed to the page and no renderer IPC
 * plugin system exists, so the window keeps Chromium's strict sandbox. The one
 * desktop-specific page (Settings → Appearance) talks to routes this process
 * registers on the host's `webServer`, gated to this window's own traffic.
 */

import { app, Menu } from 'electron';

import { BrandingController } from './branding-controller.js';
import { createBrandingRoutes } from './branding-routes.js';
import { resolveBranding, userDataDirectory } from './branding.js';
import { findHarnessAnchor } from './find-harness.js';
import { startHost, resolveOrigin, resolveAuthenticationUrl } from './host.js';
import { scheduleRelaunch } from './relaunch.js';
import { ShellGeneration } from './shell-generation.js';
import { buildMenuTemplate, commandScript } from './shortcuts.js';

const verbose = process.env.DSH_DESKTOP_VERBOSE === '1';

/**
 * Emit a shell diagnostic line.
 * @param message - text to log.
 */
function log(message) {
  if (verbose) process.stdout.write(`dsh-desktop: ${message}\n`);
}

// Pin userData before anything reads it. Electron derives the default from the
// app name, so a rename would otherwise move cookies and local storage to a
// fresh directory. `userDataDirectory` is also what the launcher uses to find
// saved branding, so both sides agree (and both honour DSH_DESKTOP_USER_DATA,
// for a constrained HOME where the platform default is not writable).
app.setPath('userData', userDataDirectory());

/**
 * Identity this process launched with — what the bundle's Info.plist shows
 * for as long as it runs. Later Settings changes are compared against it.
 */
const launched = resolveBranding();

// Electron's own menus, the About panel, and notifications read this. The
// menu-bar title and Cmd-Tab label come from the bundle's Info.plist instead,
// which `scripts/start.mjs` stamps with the same name.
app.setName(launched.name);

/** Live host tree for the current generation. */
let host;
/** Live shell generation. */
let generation;
/** Disposers for the branding routes on the live host. */
let removeRoutes = [];
/** Set once shutdown has begun, so `before-quit` runs its teardown once. */
let quitting = false;

const branding = new BrandingController({
  launched,
  log,
  relaunch: async () => {
    // The helper waits for this process to exit, rebuilds the bundle with the
    // saved identity, and starts it. Forward the Chromium flags this instance
    // was started with (e.g. the sandbox workaround) so the new one can start
    // in the same environment.
    scheduleRelaunch({
      executable: process.execPath,
      args: process.argv.slice(1).filter((arg) => arg.startsWith('--')),
      env: process.env,
    });
    app.quit();
  },
});

/**
 * Register the branding routes on the live host.
 * @param origin - carrier origin.
 */
function registerBrandingRoutes(origin) {
  const webServer = host.ctx.get('webServer');
  const connection = host.ctx.get('connection');
  const routes = createBrandingRoutes({
    origin,
    // Read through the generation on every request, so a released window's
    // capability is never accepted.
    accessHeader: () => generation?.accessHeader,
    requestRejection: (req) => connection.requestRejection(req),
    controller: branding,
    log,
  });
  removeRoutes = routes.map(({ path, handler }) =>
    webServer.register({ kind: 'exact', path, handler }),
  );
}

/**
 * Install the application menu, which carries the keyboard shortcuts.
 *
 * Page commands are resolved against the live generation at click time, so a
 * menu built once never holds on to a released window.
 */
function installMenu() {
  const template = buildMenuTemplate({
    platform: process.platform,
    locale: app.getLocale(),
    appName: launched.name,
    dispatch: (id) => {
      generation?.dispatchCommand(commandScript(id));
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Boot the host tree and mount the first shell generation.
 */
async function main() {
  // Dock icon and About panel. Set at runtime as well as in the bundle so a
  // plain `electron .` launch, which runs the stock Electron.app, is branded.
  branding.applyInitial();
  installMenu();

  const { anchor, source } = findHarnessAnchor();
  log(`using DSH from ${source}`);

  host = await startHost({
    profile: process.env.DSH_DESKTOP_PROFILE ?? 'web',
    anchor,
    port: Number(process.env.DSH_DESKTOP_PORT ?? 0),
    log,
  });

  const origin = resolveOrigin(host.ctx);
  const authenticationUrl = resolveAuthenticationUrl(host.ctx, origin);
  registerBrandingRoutes(origin);

  // Smoke mode verifies that the client really mounted and then exits, so a
  // launch can be validated without a human watching the window.
  const smoke = process.env.DSH_DESKTOP_SMOKE === '1';

  generation = new ShellGeneration({ log });
  await generation.mount({
    origin,
    authenticationUrl,
    title: launched.name,
    verifyClient: smoke,
  });

  // End-to-end exercise of the rename + relaunch path, driven from inside the
  // page exactly as the Settings section does. Test-only; see
  // scripts/test-relaunch.mjs.
  const rename = process.env.DSH_DESKTOP_TEST_RENAME;
  if (rename !== undefined && !smoke) {
    await generation.exerciseRename(rename);
    return;
  }

  if (smoke) {
    // Through the installed menu items, so the accelerator wiring is covered
    // and not just the page-side listener.
    await generation.verifyShortcuts((id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(`dsh-desktop.${id}`);
      if (item === null || item === undefined) throw new Error(`dsh-desktop: no menu item for ${id}`);
      item.click();
    });
    await generation.verifyBrandingPage();
    process.stdout.write('dsh-desktop: SMOKE OK\n');
    await teardown();
    app.exit(0);
  }
}

/**
 * Release the shell generation and the host tree, in that order.
 *
 * The window is torn down first so no in-flight renderer request can reach a
 * half-disposed Cordis tree.
 */
async function teardown() {
  const shell = generation;
  generation = undefined;
  if (shell !== undefined) {
    try {
      await shell.release();
    } catch (error) {
      process.stderr.write(`dsh-desktop: shell release failed: ${String(error)}\n`);
    }
  }

  for (const remove of removeRoutes.splice(0)) {
    try {
      remove();
    } catch {
      // The webServer may already be gone; its routes went with it.
    }
  }

  const tree = host;
  host = undefined;
  if (tree !== undefined) {
    try {
      await tree.dispose();
    } catch (error) {
      process.stderr.write(`dsh-desktop: host disposal failed: ${String(error)}\n`);
    }
  }
}

// A second launch must not boot a second host tree against the same profile
// directory: two Cordis generations would contend for the same session store.
// The already-running instance is brought forward instead.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    generation?.show();
  });

  app
    .whenReady()
    .then(main)
    .catch(async (error) => {
      // A startup failure is usually an environment problem the user can fix,
      // so lead with the message. The stack only helps when the cause is a
      // defect here, and is kept behind the verbose flag.
      process.stderr.write(`\n${String(error?.message ?? error)}\n\n`);
      if (verbose && error?.stack !== undefined) {
        process.stderr.write(`${String(error.stack)}\n`);
      }
      await teardown();
      app.exit(1);
    });
}

// Clicking the Dock icon with no window open is the standard macOS way to
// return to a running app.
app.on('activate', () => {
  generation?.show();
});

app.on('window-all-closed', () => {
  // On macOS an app normally stays resident when its last window closes, but
  // this shell's whole purpose is that one window, and the host tree it owns is
  // expensive to keep running unseen.
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  // Cordis disposal is asynchronous; hold the quit until the tree has released
  // its subprocesses and the session log has been flushed.
  event.preventDefault();
  void teardown().finally(() => {
    app.exit(0);
  });
});
