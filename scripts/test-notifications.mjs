/** Headless native notification tests; no Electron process or OS prompts. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installNotifications } from '../src/main/notifications.js';

const hooks = new Map();
const ctx = {
  on(name, listener, options) {
    assert.equal(options.global, true);
    if (name.endsWith('/request')) assert.equal(options.prepend, true);
    hooks.set(name, listener);
    return () => hooks.delete(name);
  },
};
let supported = true;
let throws = false;
const shown = [];
class Notification extends EventEmitter {
  static isSupported() { return supported; }
  constructor(options) { super(); this.options = options; }
  show() {
    if (throws) throw new Error('OS failure');
    shown.push(this);
  }
  close() { this.closed = true; this.emit('close'); }
}
let focused = false;
let alive = true;
let clicks = 0;
let shell = { get alive() { return alive; }, get focused() { return focused; }, show() { clicks++; } };
const dispose = installNotifications({ ctx, Notification, getShell: () => shell, appName: 'My App', locale: 'zh-TW' });
const session = { header: { id: 's1', origin: 'user' } };
const event = (type, data, owner = session) => hooks.get('session/event')(owner, { type, data });
function turn({ owner = session, source = 'user', reason = 'completed', id = 1 } = {}) {
  event('turn/start', { turn: id }, owner);
  event('user/message', { source: { kind: source } }, owner);
  event('turn/end', { turn: id, reason: { kind: reason } }, owner);
}
turn();
assert.deepEqual(shown[0].options, { title: 'My App', body: '任務已完成。' });
event('turn/end', { turn: 1, reason: { kind: 'completed' } });
turn({ source: 'plugin' });
turn({ reason: 'aborted' });
turn({ owner: { header: { id: 'child', origin: 'subagent' } } });
assert.equal(shown.length, 1, 'no duplicates, autonomous turns, cancelled turns, or children');
turn({ reason: 'error' });
turn({ reason: 'max-tokens' });
assert.equal(shown.length, 3);

focused = true;
turn();
focused = false;
alive = false;
turn();
alive = true;
supported = false;
turn();
supported = true;
assert.equal(shown.length, 3, 'foreground, dead shell and unsupported OS are silent');

const answer = Promise.resolve({ answers: [] });
const question = hooks.get('user-questions/request');
assert.equal(question({ questions: [{ question: 'SECRET' }] }, () => answer), answer);
assert.equal(shown.at(-1).options.body, '有問題需要你回覆。');
const approval = hooks.get('approval/request');
assert.equal(approval({}, () => 'rejected'), 'rejected');
assert.equal(shown.at(-1).options.body, '有操作需要你核准。');
assert.throws(() => question({}, () => { throw new Error('answerer failure'); }), /answerer failure/);
const count = shown.length;
assert.equal(question({ signal: AbortSignal.abort() }, () => 'aborted'), 'aborted');
assert.equal(shown.length, count);
throws = true;
assert.equal(approval({}, () => 'allowed-once'), 'allowed-once', 'OS failure cannot change approval');
throws = false;
shown[0].emit('click');
assert.equal(clicks, 1);
assert.equal(shown[0].listenerCount('click'), 0);

// A disposed session cannot produce a stale completion.
event('turn/start', { turn: 7 });
event('user/message', { source: { kind: 'user' } });
hooks.get('session/disposed')(session);
event('turn/end', { turn: 7, reason: { kind: 'completed' } });
assert.equal(shown.length, count);
event('turn/start', { turn: 8 });
hooks.get('agent/inbox/claimed')({ agent: { session }, message: { source: { kind: 'user' } }, turn: 8 });
event('turn/end', { turn: 8, reason: { kind: 'error' } });
assert.equal(shown.length, count + 1, 'human input failing before commit still alerts');
event('turn/start', { turn: 9 });
hooks.get('agent/inbox/claimed')({ agent: { session }, message: { source: { kind: 'user' } }, turn: 8 });
event('turn/end', { turn: 9, reason: { kind: 'completed' } });
assert.equal(shown.length, count + 1, 'claims must match the current turn');
for (let i = 0; i < 25; i++) approval({}, () => 'rejected');
assert.ok(shown.some((item) => item.closed), 'native object retention is bounded');
const last = shown.at(-1);
dispose();
dispose();
assert.equal(hooks.size, 0);
assert.equal(last.closed, true);
last.emit('click');
assert.equal(clicks, 1, 'shutdown removes click callbacks');
shell = undefined;
assert.equal(question({}, () => 'done'), 'done');
assert.equal(shown.at(-1), last);
console.log('notification tests passed');
