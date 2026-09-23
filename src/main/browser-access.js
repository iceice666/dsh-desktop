/**
 * Generation-scoped capability separating the Electron renderer from an
 * ordinary browser pointed at the same loopback port.
 *
 * The host binds a real TCP port, so anything on the machine can reach it. The
 * upstream cookie proves "a browser that completed the token exchange"; this
 * header proves "the Electron renderer of this specific generation". They are
 * different claims, and the desktop needs both.
 *
 * The value lives only in main-process memory and is attached by the renderer's
 * own network session, never by page code.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Header attached only by the Electron renderer's native network session. */
export const RENDERER_ACCESS_HEADER = 'x-dsh-desktop-renderer';

/** 32 random bytes rendered base64url is 43 characters. */
const ACCESS_TOKEN_BYTES = 32;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Mint one unpredictable renderer capability for a single host generation.
 *
 * A fresh token per generation means a leaked value cannot outlive the window
 * it was minted for.
 *
 * @returns frozen `{ name, value }` suitable for a request header.
 */
export function createRendererAccessHeader() {
  return Object.freeze({
    name: RENDERER_ACCESS_HEADER,
    value: randomBytes(ACCESS_TOKEN_BYTES).toString('base64url'),
  });
}

/**
 * Compare a presented token against the expected one in constant time.
 *
 * Length and shape are checked first because `timingSafeEqual` throws on
 * mismatched lengths; both checks are safe to short-circuit since neither
 * reveals anything about the secret's content.
 *
 * @param actual - token presented by a request, if any.
 * @param expected - this generation's token.
 * @returns whether the tokens match.
 */
export function sameAccessToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  if (!ACCESS_TOKEN_PATTERN.test(actual)) return false;
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
