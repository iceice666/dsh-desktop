/**
 * Host half of the branding Settings page: intentionally empty.
 *
 * The page is browser-only. Its routes need the Electron main process (the
 * Dock, the native file dialog, the relaunch), which a Cordis host plugin has
 * no handle on, so `src/main/branding-routes.js` registers them on the live
 * `webServer` directly. This row exists so `client-modules` finds the
 * package's `dsh.client` declaration and serves `./client`.
 */

/** Host plugin body — nothing to do on the host. */
export function apply() {}
