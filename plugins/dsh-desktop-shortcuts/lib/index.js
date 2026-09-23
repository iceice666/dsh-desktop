/**
 * Host half of the keyboard shortcuts plugin: intentionally empty.
 *
 * The accelerators live on the Electron application menu (src/main/shortcuts.js)
 * and the commands run in the browser (./client.js). This row exists so
 * `client-modules` finds the package's `dsh.client` declaration and serves
 * `./client`.
 */

/** Host plugin body — nothing to do on the host. */
export function apply() {}
