/**
 * Verify that the harness installation is discovered without configuration,
 * and that discovery yields an anchor the host boot can actually use.
 *
 * Usage: node scripts/test-find-harness.mjs
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { findHarnessAnchor } from '../src/main/find-harness.js';

const require = createRequire(import.meta.url);

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

// Discovery must work with no DSH_ANCHOR set, which is the ordinary case for
// someone who installed DSH and simply runs the app.
const saved = process.env.DSH_ANCHOR;
delete process.env.DSH_ANCHOR;

let discovered;
try {
  discovered = findHarnessAnchor();
} catch (error) {
  console.error(`FAILED: discovery threw without DSH_ANCHOR:\n${String(error.message)}`);
  process.exit(1);
}

console.log(`anchor = ${discovered.anchor}`);
console.log(`source = ${discovered.source}`);

check('an anchor was found', typeof discovered.anchor === 'string' && discovered.anchor.length > 0);
check('the source is reported', typeof discovered.source === 'string');
check('the anchor is a node_modules directory', discovered.anchor.endsWith('node_modules'));

// The two packages the host boot imports must both resolve, the sibling from
// where `dsh` itself lives — exactly what startHost does.
let entry;
try {
  entry = require.resolve('@deepseek-ai/dsh/lib/profile-boot.js', { paths: [discovered.anchor] });
  check('profile-boot resolves from the anchor', true);
} catch {
  check('profile-boot resolves from the anchor', false);
}

if (entry !== undefined) {
  try {
    require.resolve('@deepseek-ai/dsh-app-boot', { paths: [discovered.anchor, dirname(entry)] });
    check('app-boot resolves alongside dsh', true);
  } catch {
    check('app-boot resolves alongside dsh', false);
  }
}

// An explicit anchor still wins when it is usable.
process.env.DSH_ANCHOR = discovered.anchor;
check('explicit DSH_ANCHOR is honoured', findHarnessAnchor().source === 'DSH_ANCHOR');

// A bad explicit anchor must not be accepted silently; discovery falls back.
process.env.DSH_ANCHOR = '/nonexistent/node_modules';
const fallback = findHarnessAnchor();
check('an unusable DSH_ANCHOR falls back to discovery', fallback.source !== 'DSH_ANCHOR');

if (saved === undefined) delete process.env.DSH_ANCHOR;
else process.env.DSH_ANCHOR = saved;

if (failures.length > 0) {
  console.error(`FAILED ${String(failures.length)} of ${String(passed + failures.length)}:`);
  for (const name of failures) console.error(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`ok — ${String(passed)} assertions passed`);
