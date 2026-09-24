/** Native attention, driven by live host events without exposing renderer APIs. */

const COPY = {
  en: {
    completed: 'Your task has finished.',
    failed: 'Your task could not finish. Open the app for details.',
    question: 'A question needs your reply.',
    approval: 'An action needs your approval.',
  },
  zh: {
    completed: '任務已完成。',
    failed: '任務未能完成，請開啟應用程式查看詳情。',
    question: '有問題需要你回覆。',
    approval: '有操作需要你核准。',
  },
};

/**
 * Observe committed session events and wrap human-request waterfalls without
 * changing their arguments, answers, errors, or cancellation semantics.
 * Native failures must never interrupt a turn or an approval request.
 */
export function installNotifications({ ctx, Notification, getShell, appName, locale, log = () => {} }) {
  const copy = COPY[locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en'];
  const turns = new Map();
  const active = new Set();
  let disposed = false;

  function forget(notification) {
    active.delete(notification);
    notification.removeAllListeners();
  }

  function notify(kind) {
    if (disposed) return;
    try {
      const shell = getShell();
      if (!shell?.alive || shell.focused || !Notification.isSupported()) return;
      // Bound retained native objects when the OS keeps notifications in its tray.
      if (active.size >= 20) {
        const oldest = active.values().next().value;
        forget(oldest);
        oldest.close();
      }
      const notification = new Notification({ title: appName, body: copy[kind] });
      active.add(notification);
      notification.once('click', () => {
        if (!disposed) getShell()?.show();
        forget(notification);
      });
      notification.once('close', () => forget(notification));
      notification.once('failed', () => {
        log('native notification could not be displayed');
        forget(notification);
      });
      try {
        notification.show();
      } catch (error) {
        forget(notification);
        throw error;
      }
    } catch (error) {
      log(`native notification failed: ${String(error)}`);
    }
  }

  const removers = [];
  try {
    removers.push(ctx.on('session/event', (session, event) => {
      if (session.header.origin === 'subagent') return;
      if (event.type === 'turn/start') {
        turns.set(session, { turn: event.data.turn, userInitiated: false });
      } else if (event.type === 'user/message') {
        const turn = turns.get(session);
        if (turn && event.data.source?.kind === 'user') turn.userInitiated = true;
      } else if (event.type === 'turn/end') {
        const turn = turns.get(session);
        if (!turn || turn.turn !== event.data.turn) return;
        turns.delete(session);
        if (!turn.userInitiated) return;
        const reason = event.data.reason.kind;
        if (reason === 'completed') notify('completed');
        else if (reason === 'error' || reason === 'max-tokens') notify('failed');
      }
    }, { global: true }));
    // Input is claimed before prompt/provider preparation. Those stages can
    // fail before user/message is committed, but still deserve a failure alert.
    removers.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const open = turns.get(agent.session);
      if (open?.turn === turn && message.source?.kind === 'user') open.userInitiated = true;
    }, { global: true }));
    removers.push(ctx.on('session/disposed', (session) => turns.delete(session), { global: true }));
    for (const [event, kind] of [['user-questions/request', 'question'], ['approval/request', 'approval']]) {
      // Prepend so a UI answerer cannot consume the waterfall before this
      // observer. Global makes the observer visible to agent-scoped dispatch.
      removers.push(ctx.on(event, (request, next) => {
        if (!request.signal?.aborted) notify(kind);
        return next();
      }, { prepend: true, global: true }));
    }
  } catch (error) {
    for (const remove of removers.reverse()) remove();
    throw error;
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const remove of removers.reverse()) remove();
    turns.clear();
    for (const notification of active) {
      forget(notification);
      try { notification.close(); } catch { /* OS may already have dismissed it. */ }
    }
  };
}
