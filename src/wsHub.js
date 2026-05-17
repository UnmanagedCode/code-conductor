// WebSocket hub. One /ws endpoint multiplexes subscriptions to many instances.
//
// Client → server:
//   { t: "subscribe",   id }
//   { t: "unsubscribe", id }
//   { t: "prompt",      id, text }
//   { t: "mode",        id, mode }
//   { t: "interrupt",   id }
//   { t: "kill",        id }
//
// Server → client:
//   { t: "snapshot",  id, status, mode, sessionId, project, events: [...] }
//   { t: "event",     id, ev }
//   { t: "status",    id, status, sessionId, mode }
//   { t: "closed",    id, code, signal }
//   { t: "projects" }              // hint to re-fetch /api/projects
//   { t: "instances" }             // hint to re-fetch /api/instances
//   { t: "ack",       reqId, ok, error? }
//   { t: "error",     message }

import { WebSocket } from 'ws';

export function attachWsHub({ wss, instances }) {
  const subscribers = new Map(); // instanceId -> Set<ws>

  function subsFor(id) {
    let s = subscribers.get(id);
    if (!s) { s = new Set(); subscribers.set(id, s); }
    return s;
  }

  instances.on('event', ({ id, ev }) => {
    const subs = subscribers.get(id);
    if (subs) {
      const msg = JSON.stringify({ t: 'event', id, ev });
      for (const ws of subs) safeSend(ws, msg);
    }
    // Turn-end notifications go to every connected client (not just
    // subscribers), so users get pings for background instances they aren't
    // currently viewing in the foreground tab.
    if (ev?.kind === 'turn_end') {
      const inst = instances.get(id);
      const note = JSON.stringify({
        t: 'turn_notification',
        id,
        project: inst?.project ?? null,
        isError: !!ev.isError,
        stopReason: ev.stopReason ?? null,
        cost: ev.cost ?? null,
      });
      broadcastAll(note);
    }
  });

  instances.on('status', (summary) => {
    const subs = subscribers.get(summary.id);
    const payload = JSON.stringify({
      t: 'status',
      id: summary.id,
      status: summary.status,
      sessionId: summary.sessionId,
      mode: summary.mode,
    });
    if (subs) for (const ws of subs) safeSend(ws, payload);
    broadcastAll(JSON.stringify({ t: 'instances' }));
  });

  instances.on('list_changed', () => {
    broadcastAll(JSON.stringify({ t: 'instances' }));
  });

  function broadcastAll(msg) {
    for (const ws of wss.clients) safeSend(ws, msg);
  }

  function safeSend(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ignore */ }
    }
  }

  wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { safeSend(ws, JSON.stringify({ t: 'error', message: 'invalid json' })); return; }

      const reply = (ok, error) => safeSend(ws, JSON.stringify({ t: 'ack', reqId: msg.reqId ?? null, ok, error }));
      const inst = msg.id ? instances.get(msg.id) : null;

      try {
        switch (msg.t) {
          case 'subscribe': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            subsFor(msg.id).add(ws);
            safeSend(ws, JSON.stringify({
              t: 'snapshot',
              id: inst.id,
              project: inst.project,
              status: inst.status,
              mode: inst.mode,
              sessionId: inst.sessionId,
              events: inst.ringSnapshot(),
            }));
            reply(true);
            return;
          }
          case 'unsubscribe': {
            if (msg.id) subscribers.get(msg.id)?.delete(ws);
            reply(true);
            return;
          }
          case 'prompt': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            inst.prompt(String(msg.text ?? ''));
            reply(true);
            return;
          }
          case 'mode': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            await inst.setMode(String(msg.mode));
            reply(true);
            return;
          }
          case 'interrupt': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            await inst.interrupt();
            reply(true);
            return;
          }
          case 'kill': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            await inst.kill();
            reply(true);
            return;
          }
          default:
            reply(false, `unknown message type: ${msg.t}`);
        }
      } catch (e) {
        reply(false, e.message ?? 'error');
      }
    });

    ws.on('close', () => {
      for (const subs of subscribers.values()) subs.delete(ws);
    });

    safeSend(ws, JSON.stringify({ t: 'hello' }));
  });
}
