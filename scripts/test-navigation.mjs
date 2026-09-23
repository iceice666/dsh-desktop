/**
 * Headless tests for the window containment rules.
 *
 * Each case below corresponds to a way page content could try to escape the
 * carrier origin or reach the operating system.
 *
 * Usage: node scripts/test-navigation.mjs
 */

import {
  blocksNavigation,
  externalPopupTarget,
  isSameOrigin,
} from '../src/main/navigation-policy.js';

const ORIGIN = 'http://127.0.0.1:61530';

let passed = 0;
const failures = [];

/**
 * @param name - assertion label.
 * @param condition - result under test.
 */
function check(name, condition) {
  if (condition === true) {
    passed += 1;
    return;
  }
  failures.push(name);
}

// ── origin matching ───────────────────────────────────────────────────────

check('carrier root is same-origin', isSameOrigin(`${ORIGIN}/`, ORIGIN));
check('carrier subpath is same-origin', isSameOrigin(`${ORIGIN}/api/x?y=1`, ORIGIN));
check('different port is not same-origin', isSameOrigin('http://127.0.0.1:9999/', ORIGIN) === false);
check('different host is not same-origin', isSameOrigin('http://localhost:61530/', ORIGIN) === false);
check('https on same authority is not same-origin', isSameOrigin('https://127.0.0.1:61530/', ORIGIN) === false);
check('malformed URL is not same-origin', isSameOrigin('not a url', ORIGIN) === false);

// ── top-level navigation ──────────────────────────────────────────────────

check(
  'main-frame navigation on carrier is allowed',
  blocksNavigation(`${ORIGIN}/session/1`, ORIGIN, true) === false,
);
check(
  'main-frame navigation off carrier is blocked',
  blocksNavigation('https://example.com/', ORIGIN, true) === true,
);
check(
  'about:blank in the main frame is blocked, not launched',
  blocksNavigation('about:blank', ORIGIN, true) === true,
);
check(
  'file URL in the main frame is blocked',
  blocksNavigation('file:///etc/passwd', ORIGIN, true) === true,
);
check(
  'subframe navigation off carrier is left alone',
  blocksNavigation('https://example.com/embed', ORIGIN, false) === false,
);
check(
  'missing isMainFrame is treated as a subframe',
  blocksNavigation('https://example.com/', ORIGIN, undefined) === false,
);

// ── popup handling ────────────────────────────────────────────────────────

check(
  'https popup is opened externally',
  externalPopupTarget('https://example.com/docs') === 'https://example.com/docs',
);
check(
  'http popup is opened externally',
  externalPopupTarget('http://example.com/') === 'http://example.com/',
);
check(
  'mailto popup is opened externally',
  externalPopupTarget('mailto:someone@example.com') === 'mailto:someone@example.com',
);
check('file popup is denied silently', externalPopupTarget('file:///etc/passwd') === undefined);
check(
  'javascript popup is denied silently',
  externalPopupTarget('javascript:alert(1)') === undefined,
);
check(
  'custom scheme popup is denied silently',
  externalPopupTarget('someapp://run?cmd=rm') === undefined,
);
check('malformed popup target is denied silently', externalPopupTarget('::::') === undefined);

// ── report ────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`FAILED ${String(failures.length)} of ${String(passed + failures.length)}:`);
  for (const name of failures) console.error(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`ok — ${String(passed)} assertions passed`);
