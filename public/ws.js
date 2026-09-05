// Reconnecting WebSocket client for the orchestrator.
//
// Exposes a single `bus` event target whose events mirror server messages
// plus connection-state ('open' / 'close' / 'reconnecting').

export const bus = new EventTarget();
let ws = null;
let reconnectTimer = null;
let nextReqId = 1;
const pending = new Map();

export function connect() {
  cleanup();
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.addEventListener('open', () => bus.dispatchEvent(new CustomEvent('open')));
  ws.addEventListener('close', () => {
    bus.dispatchEvent(new CustomEvent('close'));
    scheduleReconnect();
  });
  ws.addEventListener('error', () => { /* let close fire */ });
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'ack' && msg.reqId != null) {
      const p = pending.get(msg.reqId);
      // clearTimeout on BOTH outcomes, not just the resolve: an acked send must
      // leave nothing behind at all. See send().
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.reqId);
        msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error || 'error'));
      }
      return;
    }
    bus.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
  });
}

// KNOWN AND LEFT: `pending` is not drained here, so an ack in flight across a
// reconnect stays pending until its 10s deadline rejects it. Rejecting on close
// instead would alert() the user on every reconnect that caught a send mid-flight,
// which is a user-visible behaviour change and not what card 2026-0344 measured.
function cleanup() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws && ws.readyState !== WebSocket.CLOSED) { try { ws.close(); } catch {} }
  ws = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  bus.dispatchEvent(new CustomEvent('reconnecting'));
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1000);
}

export function send(t, payload = {}, { ack = false } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (ack) return Promise.reject(new Error('not connected'));
    return;
  }
  const msg = { t, ...payload };
  if (ack) {
    const reqId = `c${nextReqId++}`;
    msg.reqId = reqId;
    const p = new Promise((resolve, reject) => {
      // The deadline is a CONTRACT — a send whose ack never arrives must reject so
      // callers like sendCardAnswer's onFail can re-open the card
      // (tests/ws-deferred-steer.test.mjs) — but it must not outlive the ack.
      // Both mechanisms are load-bearing and they answer different questions:
      //   * the ack path clearTimeout()s this handle, so an ACKED send leaves
      //     nothing behind. That is the fix.
      //   * unref makes an UNACKED send unable to hold a Node event loop open for
      //     ten seconds after the work is done — the structural belt, which is what
      //     closes the class rather than the current call sites. Under node:test the
      //     loop is alive while tests run, so the reject still fires; the only case
      //     it does not is a process with nothing else to do, which is the case we
      //     want it not to hold open. `?.` because browsers have no unref (the same
      //     guarded form as public/blocks.js).
      const timer = setTimeout(() => {
        if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('timeout')); }
      }, 10_000);
      timer.unref?.();
      pending.set(reqId, { resolve, reject, timer });
    });
    ws.send(JSON.stringify(msg));
    return p;
  }
  ws.send(JSON.stringify(msg));
}
