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
      if (p) { pending.delete(msg.reqId); msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error || 'error')); }
      return;
    }
    bus.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
  });
}

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
      pending.set(reqId, { resolve, reject });
      setTimeout(() => {
        if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('timeout')); }
      }, 10_000);
    });
    ws.send(JSON.stringify(msg));
    return p;
  }
  ws.send(JSON.stringify(msg));
}

export function isOpen() { return ws && ws.readyState === WebSocket.OPEN; }
