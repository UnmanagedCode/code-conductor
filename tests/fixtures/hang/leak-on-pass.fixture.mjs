// A file that PASSES while leaving a listening server open. This is the shape
// the 60s `--test-timeout` is blind to: the test body settles fine, so nothing
// is ever cancelled, yet the child never exits and node therefore never emits
// the file's terminal summary. Pre-fix this hangs tests/run.mjs forever.
import test from 'node:test';
import net from 'node:net';

test('leak-on-pass: passes but never closes its server', () => {
  net.createServer().listen(0, '127.0.0.1');
});
