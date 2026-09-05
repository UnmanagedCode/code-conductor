// The minimal stand-in for the browser's WebSocket that the DOM tests drive the
// REAL public/ws.js over, so an assertion reads the frame that actually goes on
// the wire rather than a re-implementation of it.
//
// Enough for ws.js and no more: connect() constructs it and registers listeners,
// send() checks readyState against the constructor's OPEN, and an ack is
// dispatched back SYNCHRONOUSLY for any frame carrying a reqId so an {ack:true}
// send's await settles instead of timing out into an alert().
//
// One copy, three users (card 2026-0344): it was pasted verbatim into
// tests/header-change-effort.test.mjs and tests/header-playbook-enforcement.test.mjs,
// and tests/ws-ack-timer.test.mjs needed a third. tests/anchor-autoresume.test.mjs's
// FakeWebSocket is deliberately NOT folded in — it is a different shape (no-op
// addEventListener, no ack path) serving a different test.
//
// It sets the WebSocket GLOBAL, which is what ws.js resolves; `sent` collects
// every frame as a parsed object, in send order.
export function installFakeSocket(sent) {
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { super(); this.url = url; this.readyState = FakeSocket.OPEN; }
    send(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      if (msg.reqId != null) {
        const ev = new Event('message');
        ev.data = JSON.stringify({ t: 'ack', reqId: msg.reqId, ok: true });
        this.dispatchEvent(ev);
      }
    }
    close() { this.readyState = FakeSocket.CLOSED; }
  }
  globalThis.WebSocket = FakeSocket;
}
