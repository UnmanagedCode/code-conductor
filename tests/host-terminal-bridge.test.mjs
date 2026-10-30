// The WebSocket ↔ Terminal pump of GET /api/terminal (`createTerminalBridge`,
// src/hostTerminal.ts) against a fake socket and a fake terminal: the
// backpressure levers both ways, the end-of-terminal messages and close codes,
// and the client-side close. What the real socket and a real program do is
// tests/hostTerminalRows.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Loaded per test, so a module that does not load reds each row by name.
async function load() {
  try { return await import('../src/hostTerminal.ts'); }
  catch (e) { assert.fail(`src/hostTerminal.ts does not load: ${e.message}`); }
}

// Records every call in `log`. `send` callbacks are held until `flush(n)`.
class FakeSocket extends EventEmitter {
  log = [];
  callbacks = [];
  send(data, opts, cb) {
    this.log.push(opts?.binary ? ['send', Buffer.from(data)] : ['text', JSON.parse(data)]);
    if (cb) this.callbacks.push(cb);
  }
  close(code, reason) { this.log.push(['close', code, reason]); }
  pause() { this.log.push(['pause']); }
  resume() { this.log.push(['resume']); }
  flush(n = this.callbacks.length) { for (const cb of this.callbacks.splice(0, n)) cb(); }
  calls(name) { return this.log.filter((c) => c[0] === name); }
}

class FakeTerminal {
  log = [];
  writeReturns = true;
  write(data) { this.log.push(['write', Buffer.from(data)]); return this.writeReturns; }
  resize(cols, rows) { this.log.push(['resize', cols, rows]); }
  pause() { this.log.push(['pause']); }
  resume() { this.log.push(['resume']); }
  close() { this.log.push(['close']); }
  calls(name) { return this.log.filter((c) => c[0] === name); }
}

async function attached() {
  const mod = await load();
  const bridge = mod.createTerminalBridge();
  const ws = new FakeSocket();
  const terminal = new FakeTerminal();
  bridge.attach(ws, terminal);
  return { mod, bridge, ws, terminal };
}

// PINS: output pauses the terminal exactly when the bytes the socket has not
// yet written reach TERMINAL_WS_HIGH_WATER_BYTES — not one chunk earlier — and
// resumes it only once they are all written.
test('output pauses the terminal at the high-water mark and resumes it at zero', async () => {
  const { mod, bridge, ws, terminal } = await attached();
  const HIGH = mod.TERMINAL_WS_HIGH_WATER_BYTES;
  const quarter = Buffer.alloc(HIGH / 4, 0x61);
  for (let i = 0; i < 3; i++) bridge.handlers.onData(quarter);
  assert.equal(terminal.calls('pause').length, 0, 'below the mark: no pause');
  bridge.handlers.onData(quarter);
  assert.equal(terminal.calls('pause').length, 1, 'at the mark: paused');
  assert.equal(ws.calls('send').length, 4, 'every chunk was sent as a binary message');
  ws.flush(3);
  assert.equal(terminal.calls('resume').length, 0, 'not resumed while bytes are outstanding');
  ws.flush(1);
  assert.equal(terminal.calls('resume').length, 1, 'resumed once nothing is outstanding');
});

// PINS: input backpressure is relayed: a `false` from `write` pauses the
// socket, and `onDrain` resumes it. Binary messages reach `write` as bytes.
test('a write that reports backpressure pauses the socket, and onDrain resumes it', async () => {
  const { bridge, ws, terminal } = await attached();
  ws.emit('message', Buffer.from('ab'), true);
  assert.deepEqual(terminal.calls('write'), [['write', Buffer.from('ab')]]);
  assert.equal(ws.calls('pause').length, 0, 'true: the socket keeps flowing');
  terminal.writeReturns = false;
  ws.emit('message', Buffer.from('cd'), true);
  assert.equal(ws.calls('pause').length, 1, 'false: the socket is paused');
  bridge.handlers.onDrain();
  assert.equal(ws.calls('resume').length, 1, 'onDrain: the socket is resumed');
});

// PINS: the program's exit is ONE `exit` text message, then close 1000.
test('an exit is an exit message, then close 1000', async () => {
  const { bridge, ws } = await attached();
  bridge.handlers.onExit({ kind: 'exited', code: null, signal: 'SIGTERM' });
  assert.equal(ws.log.length, 2, JSON.stringify(ws.log));
  assert.deepEqual(ws.log[0], ['text', { type: 'exit', code: null, signal: 'SIGTERM' }]);
  assert.deepEqual(ws.log[1].slice(0, 2), ['close', 1000]);
});

// PINS: a lost terminal is ONE `failed` text message naming the code, then
// close 1011.
test('a failed terminal is a failed message, then close 1011', async () => {
  const { bridge, ws } = await attached();
  const error = Object.assign(new Error('the provider went away'), { name: 'SystemError', code: 'ETRANSPORT' });
  bridge.handlers.onExit({ kind: 'failed', error });
  assert.equal(ws.log.length, 2, JSON.stringify(ws.log));
  assert.deepEqual(ws.log[0], ['text', { type: 'failed', code: 'ETRANSPORT', error: 'the provider went away' }]);
  assert.equal(ws.log[1][0], 'close');
  assert.equal(ws.log[1][1], 1011);
});

// PINS: the client's close or error closes the terminal exactly once.
test('a socket close or error closes the terminal exactly once', async () => {
  const { ws, terminal } = await attached();
  ws.emit('error', new Error('reset'));
  ws.emit('close', 1006, Buffer.alloc(0));
  assert.equal(terminal.calls('close').length, 1);
});

// PINS: output and the end that arrive before the socket is attached are
// delivered on attach, in order.
test('output and an end before the attach are delivered on attach, in order', async () => {
  const mod = await load();
  const bridge = mod.createTerminalBridge();
  bridge.handlers.onData(Buffer.from('one'));
  bridge.handlers.onData(Buffer.from('two'));
  bridge.handlers.onExit({ kind: 'exited', code: 0, signal: null });
  const ws = new FakeSocket();
  bridge.attach(ws, new FakeTerminal());
  assert.deepEqual(ws.log.slice(0, 3), [
    ['send', Buffer.from('one')], ['send', Buffer.from('two')], ['text', { type: 'exit', code: 0, signal: null }],
  ]);
  assert.equal(ws.log[3][0], 'close');
  assert.equal(ws.log[3][1], 1000);
});

// PINS: a valid `resize` reaches the terminal; any other text message closes
// 1008 with a reason and closes the terminal once.
test('a resize message resizes; any other text closes 1008 and closes the terminal', async () => {
  const { ws, terminal } = await attached();
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })), false);
  assert.deepEqual(terminal.calls('resize'), [['resize', 100, 30]]);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 100.5, rows: 30 })), false);
  assert.equal(terminal.calls('resize').length, 1, 'an invalid resize does not reach the terminal');
  const close = ws.calls('close');
  assert.equal(close.length, 1);
  assert.equal(close[0][1], 1008);
  assert.ok(typeof close[0][2] === 'string' && close[0][2].length > 0, 'the reason names the break');
  ws.emit('close', 1008, Buffer.alloc(0));
  assert.equal(terminal.calls('close').length, 1, 'the terminal is closed once');
});
