import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { backendLogPaths, rotateBackendLog, openBackendLog, readLogTail, trimLog } from '../src/plugins/backendLog.ts';

async function tmpPaths() {
  const dir = await mkdtemp('backend-log-');
  return { dir, current: path.join(dir, 'logs', 'backend.log'), previous: path.join(dir, 'logs', 'backend.prev.log') };
}

// One previous run is kept, so history stays bounded.
test('rotate moves current to previous, a second rotate overwrites previous, a missing current is fine', async () => {
  const p = await tmpPaths();
  await rotateBackendLog(p); // nothing there yet: creates the dir, no error
  await fs.writeFile(p.current, 'run one\n');
  await rotateBackendLog(p);
  assert.equal(await fs.readFile(p.previous, 'utf8'), 'run one\n');
  await assert.rejects(fs.stat(p.current), { code: 'ENOENT' });
  await fs.writeFile(p.current, 'run two\n');
  await rotateBackendLog(p);
  assert.equal(await fs.readFile(p.previous, 'utf8'), 'run two\n', 'the older run is gone');
});

// The API tail contract.
test('readLogTail: whole file under the cap, a line-aligned tail over it, exists:false when missing', async () => {
  const p = await tmpPaths();
  await fs.mkdir(path.dirname(p.current), { recursive: true });
  assert.deepEqual(await readLogTail(p.current, 100), { exists: false, size: 0, text: '', truncated: false });

  await fs.writeFile(p.current, 'alpha\nbeta\ngamma\n');
  const whole = await readLogTail(p.current, 1000);
  assert.deepEqual(whole, { exists: true, size: 17, text: 'alpha\nbeta\ngamma\n', truncated: false });

  const cut = await readLogTail(p.current, 9); // lands mid "beta"
  assert.equal(cut.truncated, true);
  assert.equal(cut.size, 17);
  assert.equal(cut.text, 'gamma\n', 'the partial first line is dropped');
});

// Trimming a file the child holds open leaves no hole and keeps the tail.
test('trimLog: an O_APPEND fd held by the "child" keeps appending after a trim; no NUL hole; tail kept', async () => {
  const p = await tmpPaths();
  await fs.mkdir(path.dirname(p.current), { recursive: true });
  const child = await openBackendLog(p.current); // stands in for the child's dup'd fd
  try {
    const lines = Array.from({ length: 400 }, (_, i) => `line-${String(i).padStart(4, '0')}\n`).join('');
    await child.appendFile(lines);

    const untouched = await trimLog(p.current, { maxBytes: 1_000_000, keepBytes: 100 });
    assert.equal(untouched, false);
    assert.equal(await fs.readFile(p.current, 'utf8'), lines, 'under the cap is left alone');

    const trimmed = await trimLog(p.current, { maxBytes: 1000, keepBytes: 200 });
    assert.equal(trimmed, true);
    await child.appendFile('after-trim\n');

    const text = await fs.readFile(p.current, 'utf8');
    assert.ok(!text.includes('\0'), 'no NUL-filled hole');
    assert.ok(text.endsWith('line-0399\nafter-trim\n'), 'the kept tail and the post-trim write are there');
    assert.match(text, /^\[cc [^\]]*log trimmed/, 'a marker records the trim');
    assert.ok(text.length <= 200 + 100 + 'after-trim\n'.length, `size ${text.length} is bounded by keep + marker`);
  } finally { await child.close(); }
});

// Path traversal guard.
test('backendLogPaths refuses a non-slug id', () => {
  assert.throws(() => backendLogPaths('../x'), /not a valid plugin id/);
  const ok = backendLogPaths('fake-plugin');
  assert.ok(ok.current.endsWith(path.join('plugins', 'logs', 'fake-plugin', 'backend.log')));
  assert.ok(ok.previous.endsWith(path.join('plugins', 'logs', 'fake-plugin', 'backend.prev.log')));
});

// A passive touch on a backend that has no log file (started before logs existed)
// must not conjure an empty one: GET /log would flip to exists:true, size:0.
test('trimLog on a missing file does nothing and does not create it', async () => {
  const p = await tmpPaths();
  await fs.mkdir(path.dirname(p.current), { recursive: true });
  assert.equal(await trimLog(p.current, { maxBytes: 10, keepBytes: 5 }), false);
  await assert.rejects(fs.stat(p.current), { code: 'ENOENT' });
});
