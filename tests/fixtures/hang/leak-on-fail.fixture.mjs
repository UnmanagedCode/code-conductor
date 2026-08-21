// The exact 2026-0183 `ws-deferred-steer` shape: cleanup written AFTER the
// assertions, so it runs on the success path only. The assertion fails, the
// close() line is never reached, and the leaked handle means the failure is
// never even reported — the run just hangs. Post-fix the run must report BOTH
// the assertion failure and the named leak.
import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';

test('leak-on-fail: cleanup only on the success path', () => {
  const server = net.createServer().listen(0, '127.0.0.1');
  assert.equal(1, 2, 'deliberate failure before cleanup');
  server.close(); // never reached — that is the point
});
