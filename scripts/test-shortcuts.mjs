/**
 * Headless tests for the keyboard shortcut table and application menu.
 *
 * Usage: node scripts/test-shortcuts.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  COMMAND_EVENT,
  PAGE_COMMANDS,
  buildMenuTemplate,
  commandScript,
  isPageCommand,
  menuLabels,
} from '../src/main/shortcuts.js';

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

/**
 * Every item in a template, depth-first.
 * @param template - menu template.
 */
function flatten(template) {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

// ── command table ─────────────────────────────────────────────────────────

const byId = new Map(PAGE_COMMANDS.map((command) => [command.id, command]));
check('ids are unique', byId.size === PAGE_COMMANDS.length);
check('Cmd/Ctrl+, opens settings', byId.get('settings')?.accelerators[0] === 'CmdOrCtrl+,');
check('Cmd/Ctrl+N starts a session', byId.get('newSession')?.accelerators.includes('CmdOrCtrl+N'));
check('Cmd/Ctrl+Shift+O also starts a session', byId.get('newSession')?.accelerators.includes('CmdOrCtrl+Shift+O'));
check('Cmd/Ctrl+B toggles the sidebar', byId.get('toggleSidebar')?.accelerators[0] === 'CmdOrCtrl+B');
check('Cmd/Ctrl+/ shows shortcuts', byId.get('shortcuts')?.accelerators[0] === 'CmdOrCtrl+/');
check('Cmd/Ctrl+1…9 select sessions', [1, 2, 3, 4, 5, 6, 7, 8, 9]
  .every((n) => byId.get(`session${String(n)}`)?.accelerators[0] === `CmdOrCtrl+${String(n)}`));

const allAccelerators = PAGE_COMMANDS.flatMap((command) => command.accelerators);
check('no accelerator is bound twice', new Set(allAccelerators).size === allAccelerators.length);
check('the table is frozen', Object.isFrozen(PAGE_COMMANDS) && Object.isFrozen(PAGE_COMMANDS[0].accelerators));

// ── dispatch script ───────────────────────────────────────────────────────

check('known ids are page commands', isPageCommand('settings'));
check('unknown ids are not page commands', isPageCommand('quit') === false);
check('non-strings are not page commands', isPageCommand({ toString: () => 'settings' }) === false);
check('prototype keys are not page commands', isPageCommand('constructor') === false);

let threw = false;
try {
  commandScript('"); alert(1); ("');
} catch {
  threw = true;
}
check('an unknown id cannot be turned into a script', threw);

{
  const events = [];
  const sandbox = {
    window: { dispatchEvent: (event) => events.push(event) },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  };
  vm.runInNewContext(commandScript('newSession'), sandbox);
  check('the script dispatches exactly one event', events.length === 1);
  check('the event has the command type', events[0]?.type === COMMAND_EVENT);
  check('the event carries the command id', events[0]?.detail === 'newSession');
}

// ── menu template ─────────────────────────────────────────────────────────

for (const platform of ['darwin', 'win32', 'linux']) {
  const dispatched = [];
  const template = buildMenuTemplate({
    platform,
    locale: 'en-US',
    appName: 'DeepSeek Harness',
    dispatch: (id) => dispatched.push(id),
  });
  const items = flatten(template);
  const bound = items.filter((item) => item.accelerator !== undefined && item.role === undefined);

  for (const command of PAGE_COMMANDS) {
    for (const accelerator of command.accelerators) {
      const item = bound.find((candidate) => candidate.accelerator === accelerator);
      check(`${platform}: ${accelerator} is on the menu`, item !== undefined);
      if (item === undefined) continue;
      check(`${platform}: hidden ${accelerator} still fires`, item.visible !== false || item.acceleratorWorksWhenHidden === true);
      item.click();
      check(`${platform}: ${accelerator} dispatches ${command.id}`, dispatched.at(-1) === command.id);
    }
  }

  const menuAccelerators = bound.map((item) => item.accelerator);
  check(`${platform}: no duplicate accelerators`, new Set(menuAccelerators).size === menuAccelerators.length);
  check(`${platform}: Edit menu kept, so copy/paste works`, items.some((item) => item.role === 'editMenu'));
  check(`${platform}: settings item appears once visibly`,
    items.filter((item) => item.id === 'dsh-desktop.settings').length === 1);
  check(`${platform}: app menu only on macOS`, (template[0].label === 'DeepSeek Harness') === (platform === 'darwin'));
}

check('zh locale gets zh labels', menuLabels('zh-TW').newSession === '新会话');
check('other locales get en labels', menuLabels('fr').newSession === 'New Session');
check('missing locale gets en labels', menuLabels(undefined).newSession === 'New Session');

// ── the client plugin declares the same table ─────────────────────────────

{
  const source = readFileSync(
    fileURLToPath(new URL('../plugins/dsh-desktop-shortcuts/lib/client.js', import.meta.url)),
    'utf8',
  );
  let registration;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (entry) => { registration = entry; } } } });
  check('client registers under its package id', registration?.id === 'dsh-desktop-shortcuts');
  const exported = registration.factory((name) => {
    if (name === 'react') return { createElement: () => null };
    throw new Error(`unexpected require ${name}`);
  });
  const client = exported.COMMANDS.map(({ id, accelerators }) => ({ id, accelerators }));
  const main = PAGE_COMMANDS.map(({ id, accelerators }) => ({ id, accelerators: [...accelerators] }));
  check('client and main command tables match', JSON.stringify(client) === JSON.stringify(main));
  check('client exports apply and inject', typeof exported.apply === 'function' && Array.isArray(exported.inject));
}

if (failures.length > 0) {
  process.stderr.write(`shortcuts: ${String(failures.length)} failed\n`);
  for (const name of failures) process.stderr.write(`  ✗ ${name}\n`);
  process.exit(1);
}
process.stdout.write(`shortcuts: ${String(passed)} passed\n`);
