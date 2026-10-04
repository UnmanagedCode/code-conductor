// THE OWNERSHIP CHECK BEHIND A FUSE ABORT, run as the real shell text with no
// sudo, no namespace and no FUSE: ABORT_OWN_CONNECTION_SH against a temp
// mountinfo file and a temp directory standing in for fusectl. The real-kernel
// arm (fuse-teardown-minor-reuse.real) is gated; this pins the check itself in
// `npm test`.
//
// PINS (T5): `1` is written to `<fusectl>/<minor>/abort` only when a mountinfo
// line has the union root as its mountpoint AND the recorded minor as its
// dev's minor. Otherwise the script exits 3 (not provably ours) or 4 (no
// fusectl entry) and writes nothing anywhere.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';
import { ABORT_OWN_CONNECTION_SH } from '../src/systems/fuse/driver.ts';

const MINOR = '120';
// The minors every fixture gives a fusectl entry, so a write to the wrong one
// is visible.
const ENTRIES = [MINOR, '121', '1200', '7'];

const line = (id, dev, mp) => `${id} 30 ${dev} / ${mp} rw,nosuid,nodev,relatime shared:1 - fuse.cc-union cc-union rw,user_id=0,group_id=0`;

async function runScript({ mountinfo, minor = MINOR, entries = ENTRIES }) {
  const dir = await mkdtemp('cc-abort-sh-');
  const fusectl = path.join(dir, 'fusectl');
  const root = path.join(dir, 'run', 'root');
  for (const m of entries) {
    await fs.mkdir(path.join(fusectl, m), { recursive: true });
    await fs.writeFile(path.join(fusectl, m, 'abort'), '');
  }
  const mi = path.join(dir, 'mountinfo');
  await fs.writeFile(mi, mountinfo(root).join('\n') + '\n');
  const code = await new Promise(r => execFile('/bin/sh', ['-c', ABORT_OWN_CONNECTION_SH, 'sh', fusectl, minor, root, mi],
    (err) => r(err ? err.code : 0)));
  const written = {};
  for (const m of entries) written[m] = await fs.readFile(path.join(fusectl, m, 'abort'), 'utf8');
  await rmrf(dir);
  return { code, written };
}

const nothingWritten = Object.fromEntries(ENTRIES.map(m => [m, '']));

describe('ABORT_OWN_CONNECTION_SH', () => {
  test('the root attached on the recorded minor: writes 1 to that minor only', async () => {
    const { code, written } = await runScript({ mountinfo: (root) => [
      line(1, '8:1', '/'),
      line(500, `0:${MINOR}`, root),
      line(501, '0:5', path.join(root, 'proc')),
    ] });
    assert.equal(code, 0);
    assert.deepEqual(written, { ...nothingWritten, [MINOR]: '1' });
  });

  test('refuses (3) and writes nothing unless the root is attached on exactly the recorded minor', async (t) => {
    const rows = {
      'the root attached on another minor': (root) => [line(500, '0:121', root)],
      'the root absent; the minor attached at a deeper mountpoint': (root) => [line(500, `0:${MINOR}`, path.join(root, 'proc'))],
      'the root absent; the minor attached at an unrelated mountpoint': () => [line(500, `0:${MINOR}`, '/elsewhere/root')],
      'the root on a minor the recorded one is a prefix of': (root) => [line(500, `0:${MINOR}0`, root)],
      'the root on a dev whose MAJOR equals the recorded minor': (root) => [line(500, `${MINOR}:7`, root)],
      'an empty mountinfo': () => [],
    };
    for (const [name, mountinfo] of Object.entries(rows)) {
      await t.test(name, async () => {
        const { code, written } = await runScript({ mountinfo });
        assert.equal(code, 3);
        assert.deepEqual(written, nothingWritten);
      });
    }
  });

  test('the root attached on the recorded minor but no fusectl entry for it: 4, nothing written', async () => {
    const entries = ENTRIES.filter(m => m !== MINOR);
    const { code, written } = await runScript({ entries, mountinfo: (root) => [line(500, `0:${MINOR}`, root)] });
    assert.equal(code, 4);
    assert.deepEqual(written, Object.fromEntries(entries.map(m => [m, ''])));
  });
});
