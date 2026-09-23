/**
 * Navigation and popup decisions for the desktop window.
 *
 * These are pure functions of a URL so the window's containment rules stay
 * verifiable without launching Chromium.
 */

/** Schemes a popup may hand to the operating system. */
const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

/**
 * Whether a URL is on the carrier origin.
 *
 * A malformed URL is never same-origin, so callers treat it as off-origin and
 * block it.
 *
 * @param candidate - URL to test.
 * @param origin - the carrier origin.
 * @returns whether the URL's origin matches.
 */
export function isSameOrigin(candidate, origin) {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Whether top-level navigation to a URL must be blocked.
 *
 * Only the main frame is governed: subframe navigation belongs to the client's
 * own embedded views.
 *
 * @param url - navigation target.
 * @param origin - the carrier origin.
 * @param isMainFrame - whether this is a top-level navigation.
 * @returns whether the navigation should be prevented.
 */
export function blocksNavigation(url, origin, isMainFrame) {
  if (isMainFrame !== true) return false;
  return !isSameOrigin(url, origin);
}

/**
 * Resolve the href a popup should hand to the system browser, if any.
 *
 * Restricting the scheme matters: passing an arbitrary URL to `openExternal`
 * would let page content invoke whatever handler the OS has registered for that
 * scheme. The popup is denied either way; this only decides whether the target
 * is also opened outside.
 *
 * @param url - popup target requested by the page.
 * @returns the href to open externally, or `undefined` to deny silently.
 */
export function externalPopupTarget(url) {
  try {
    const target = new URL(url);
    return EXTERNAL_PROTOCOLS.has(target.protocol) ? target.href : undefined;
  } catch {
    return undefined;
  }
}
