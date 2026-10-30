// Invariant: upgradeOriginAllowed admits an upgrade with no Origin, or one whose
// exactly-serialized http(s) Origin has the same host:port as its Host header
// (scheme ignored, default port dropped, case-folded); everything else is
// refused. The guard turns a refusal into a raw 403 + destroyed socket and warns
// once per distinct (Origin, Host) pair. Contract: docs/protocol.md → Handshake: Origin check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeOriginAllowed, createUpgradeOriginGuard, WARNED_PAIRS_CAP } from '../src/upgradeOrigin.ts';

const headers = (origin, host) => ({ ...(origin !== undefined && { origin }), ...(host !== undefined && { host }) });

test('upgradeOriginAllowed admits', async (t) => {
  const rows = [
    ['no Origin', undefined, '127.0.0.1:8787'],
    ['no Origin and no Host', undefined, undefined],
    ['127.0.0.1 match', 'http://127.0.0.1:8787', '127.0.0.1:8787'],
    ['localhost match', 'http://localhost:8787', 'localhost:8787'],
    ['LAN-IP match', 'http://192.168.1.20:9000', '192.168.1.20:9000'],
    ['IPv6 loopback', 'http://[::1]:8787', '[::1]:8787'],
    ['https with no port against a portless Host', 'https://abc.trycloudflare.com', 'abc.trycloudflare.com'],
    ['https :8443 (funnel / TLS LAN share)', 'https://m.tailnet.ts.net:8443', 'm.tailnet.ts.net:8443'],
    ['Host x:80 against http://x', 'http://x', 'x:80'],
    ['Host x:443 against https://x', 'https://x', 'x:443'],
    ['uppercase Host', 'http://localhost:8787', 'LOCALHOST:8787'],
    ['Vite dev server', 'http://localhost:5173', 'localhost:5173'],
  ];
  for (const [name, origin, host] of rows) {
    await t.test(name, () => assert.equal(upgradeOriginAllowed(headers(origin, host)), true));
  }
});

test('upgradeOriginAllowed refuses', async (t) => {
  const rows = [
    ['a foreign host', 'http://evil.example', '127.0.0.1:8787'],
    ['same host on another port', 'http://127.0.0.1:9999', '127.0.0.1:8787'],
    ['localhost against 127.0.0.1', 'http://localhost:8787', '127.0.0.1:8787'],
    ['null', 'null', '127.0.0.1:8787'],
    ['malformed', 'http://', '127.0.0.1:8787'],
    ['chrome-extension', 'chrome-extension://abcdefghijklmnop', 'abcdefghijklmnop'],
    ['an Origin with a path', 'http://127.0.0.1:8787/x', '127.0.0.1:8787'],
    ['a joined duplicate Origin', 'http://127.0.0.1:8787, http://127.0.0.1:8787', '127.0.0.1:8787'],
    ['Origin present but Host missing', 'http://127.0.0.1:8787', undefined],
    ['Host with userinfo', 'http://127.0.0.1:8787', 'u@127.0.0.1:8787'],
    ['Host with a path', 'http://127.0.0.1:8787', '127.0.0.1:8787/x'],
    ['Host with a query', 'http://127.0.0.1:8787', '127.0.0.1:8787?x'],
    ['https://x against Host x:80', 'https://x', 'x:80'],
  ];
  for (const [name, origin, host] of rows) {
    await t.test(name, () => assert.equal(upgradeOriginAllowed(headers(origin, host)), false));
  }
});

function fakeSocket() {
  const s = { writes: [], destroyed: false };
  s.write = (chunk) => { s.writes.push(String(chunk)); return true; };
  s.destroy = () => { s.destroyed = true; };
  return s;
}

function fakeLog() {
  const warns = [];
  return { warns, warn: (...a) => warns.push(a.join(' ')) };
}

test('guard: a refusal writes a raw 403 and destroys the socket', () => {
  const log = fakeLog();
  const admit = createUpgradeOriginGuard({ log });
  const socket = fakeSocket();
  assert.equal(admit({ headers: headers('http://evil.example', '127.0.0.1:8787') }, socket), false);
  assert.deepEqual(socket.writes, ['HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n']);
  assert.equal(socket.destroyed, true);
});

test('guard: an admitted upgrade writes nothing and leaves the socket open', () => {
  const log = fakeLog();
  const admit = createUpgradeOriginGuard({ log });
  const socket = fakeSocket();
  assert.equal(admit({ headers: headers('http://127.0.0.1:8787', '127.0.0.1:8787') }, socket), true);
  assert.deepEqual(socket.writes, []);
  assert.equal(socket.destroyed, false);
  assert.deepEqual(log.warns, []);
});

test('guard: warns once per distinct (Origin, Host) pair', () => {
  const log = fakeLog();
  const admit = createUpgradeOriginGuard({ log });
  const refuse = (origin, host) => admit({ headers: headers(origin, host) }, fakeSocket());
  refuse('http://evil.example', '127.0.0.1:8787');
  refuse('http://evil.example', '127.0.0.1:8787');
  assert.equal(log.warns.length, 1);
  assert.match(log.warns[0], /evil\.example/);
  refuse('http://evil.example', '127.0.0.1:9999');
  assert.equal(log.warns.length, 2);
  refuse('http://other.example', '127.0.0.1:8787');
  assert.equal(log.warns.length, 3);
});

test('guard: each guard owns its warned-pair memo', () => {
  const pair = headers('http://evil.example', '127.0.0.1:8787');
  const a = fakeLog();
  const b = fakeLog();
  createUpgradeOriginGuard({ log: a })({ headers: pair }, fakeSocket());
  createUpgradeOriginGuard({ log: b })({ headers: pair }, fakeSocket());
  assert.equal(a.warns.length, 1);
  assert.equal(b.warns.length, 1);
});

test('guard: the warned-pair memo is bounded and evicts the oldest pair', () => {
  const log = fakeLog();
  const admit = createUpgradeOriginGuard({ log });
  const refuse = (i) => admit({ headers: headers(`http://evil${i}.example`, '127.0.0.1:8787') }, fakeSocket());
  for (let i = 0; i <= WARNED_PAIRS_CAP; i++) refuse(i);
  assert.equal(log.warns.length, WARNED_PAIRS_CAP + 1);
  refuse(WARNED_PAIRS_CAP); // the newest pair is still remembered
  assert.equal(log.warns.length, WARNED_PAIRS_CAP + 1);
  refuse(0); // the oldest was evicted when the memo filled
  assert.equal(log.warns.length, WARNED_PAIRS_CAP + 2);
});
