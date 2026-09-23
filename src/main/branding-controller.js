/**
 * Operations behind the branding Settings page, bound to Electron.
 *
 * What takes effect when:
 *
 * - icon: the Dock icon and About panel update immediately; the bundle icon
 *   (Finder, Cmd-Tab) follows on the next launch;
 * - name: the About panel and Electron's own menus update immediately; the
 *   menu-bar title and Cmd-Tab label come from the bundle's Info.plist, which
 *   only a relaunch from a rebuilt bundle can change.
 *
 * `state()` reports whether the running process still shows a stale identity,
 * so the page can offer the relaunch only when it would change something.
 */

import { app, dialog, nativeImage, BrowserWindow } from 'electron';

import {
  BrandingPreferences,
  iconIdentity,
  ICON_EXTENSIONS,
  MAX_NAME_LENGTH,
  resolveBranding,
  userDataDirectory,
} from './branding.js';

/** Edge length of the preview served to the page. */
const PREVIEW_SIZE = 256;

export class BrandingController {
  #preferences;
  #launched;
  #relaunch;
  #log;

  /**
   * @param options - `{ launched, relaunch, log }`: what the running bundle
   *   shows, as `{ name, icon }` with `icon` an {@link iconIdentity} value; a
   *   function performing the relaunch; and a diagnostics sink.
   */
  constructor(options) {
    this.#preferences = new BrandingPreferences(userDataDirectory());
    this.#launched = options.launched;
    this.#relaunch = options.relaunch;
    this.#log = options.log;
  }

  /** Apply the Dock icon and About panel at startup. */
  applyInitial() {
    this.#applyIcon();
  }

  /** @returns the effective identity right now. */
  #current() {
    return resolveBranding();
  }

  /**
   * @returns the page's view model: effective values, which layer each came
   *   from, what the running bundle shows, and whether a relaunch is needed.
   */
  state() {
    const current = this.#current();
    const saved = this.#preferences.read();
    return {
      name: current.name,
      nameSource: current.sources.name,
      savedName: saved.name ?? null,
      iconSource: current.sources.icon,
      hasIcon: current.iconPng !== undefined || current.iconIcns !== undefined,
      launchedName: this.#launched.name,
      restartRequired: this.#restartRequired(current),
      maxNameLength: MAX_NAME_LENGTH,
      // A macOS-only concept: other platforms have no bundle to rebuild.
      platform: process.platform,
    };
  }

  /**
   * Save or clear the display name.
   * @param name - new name, or `undefined` to fall back to the default.
   * @returns the new state.
   */
  setName(name) {
    this.#preferences.setName(name);
    const current = this.#current();
    // Electron's own menus and the About panel follow immediately.
    app.setName(current.name);
    this.#applyAboutPanel(current);
    for (const window of BrowserWindow.getAllWindows()) window.setTitle(current.name);
    return this.state();
  }

  /**
   * Show the native file dialog and adopt the chosen icon.
   * @returns the new state, with `cancelled: true` when the user backed out.
   */
  async chooseIcon() {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Choose App Icon',
      properties: ['openFile'],
      filters: [{ name: 'Icon', extensions: ICON_EXTENSIONS.map((ext) => ext.slice(1)) }],
    };
    const result = parent === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
    if (result.canceled || result.filePaths.length === 0) return { ...this.state(), cancelled: true };

    const path = result.filePaths[0];
    // Decode before saving so an image Electron cannot read is refused with a
    // message rather than silently producing a blank Dock tile.
    if (nativeImage.createFromPath(path).isEmpty()) {
      throw new Error('dsh-desktop: the selected file could not be decoded as an image');
    }
    this.#preferences.setIcon(path);
    this.#applyIcon();
    return this.state();
  }

  /** @returns the new state after reverting to the default icon. */
  resetIcon() {
    this.#preferences.setIcon(undefined);
    this.#applyIcon();
    return this.state();
  }

  /** @returns PNG bytes of the effective icon, or `undefined` when none. */
  async iconPng() {
    const image = this.#image(this.#current());
    if (image === undefined) return undefined;
    return image.resize({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, quality: 'best' }).toPNG();
  }

  /** Relaunch into a bundle rebuilt with the saved identity. */
  async restart() {
    this.#log?.('relaunching to apply branding');
    await this.#relaunch();
  }

  /** Apply the effective icon to the Dock and About panel. */
  #applyIcon() {
    const current = this.#current();
    const image = this.#image(current);
    if (image !== undefined) app.dock?.setIcon(image);
    this.#applyAboutPanel(current);
  }

  /** @param current - effective identity. */
  #applyAboutPanel(current) {
    const iconPath = current.iconPng ?? current.iconIcns;
    app.setAboutPanelOptions({
      applicationName: current.name,
      applicationVersion: app.getVersion(),
      version: `Electron ${process.versions.electron}`,
      ...(iconPath === undefined ? {} : { iconPath }),
    });
  }

  /**
   * @param current - effective identity.
   * @returns the decoded icon, or `undefined`.
   */
  #image(current) {
    const path = current.iconPng ?? current.iconIcns;
    if (path === undefined) return undefined;
    const image = nativeImage.createFromPath(path);
    return image.isEmpty() ? undefined : image;
  }

  /**
   * Whether the bundle this process runs from shows something other than the
   * effective identity. Only macOS stamps a bundle.
   *
   * @param current - effective identity.
   * @returns whether a relaunch would change what the OS displays.
   */
  #restartRequired(current) {
    if (process.platform !== 'darwin') return false;
    const launched = this.#launched;
    return launched.name !== current.name || launched.icon !== iconIdentity(current);
  }
}
