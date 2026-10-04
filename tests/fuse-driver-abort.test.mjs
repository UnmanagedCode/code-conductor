// THE REAL DRIVER'S ABORT PATH, with no sudo and no namespace: the driver
// `realMountDriver` is built by (`createRealMountDriver`), its one command
// handed to an injected runner, and the runner it ships with (`runStatus`).
//
// PINS (T8): the abort writes only through the ownership-checked script —
// a detached root writes nothing, an attached one writes `1`.
// PINS (T9): the exit mapping — 0 aborted, 3 not-mounted, 4 no-entry, and
// every other status, including no exit at all, failed.
// PINS (T10): `runStatus` reports a command that never reached an exit as
// null, never as a status — and so never as success.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';
import { createRealMountDriver, runStatus } from '../src/systems/fuse/driver.ts';
import { localExec, renderMountinfo } from './fuseAbortSeam.mjs';

const MINOR = '120';

// The shipping abort, run against a temp fusectl directory holding an entry for
// MINOR and a mountinfo listing `mounts`.
async function abortAgainst({ attached }) {
  const dir = await mkdtemp('cc-driver-abort-');
  const fusectl = path.join(dir, 'fusectl');
  const root = path.join(dir, 'run', 'root');
  await fs.mkdir(path.join(fusectl, MINOR), { recursive: true });
  await fs.writeFile(path.join(fusectl, MINOR, 'abort'), '');
  const mountinfo = path.join(dir, 'mountinfo');
  await fs.writeFile(mountinfo, renderMountinfo(attached ? [root] : [path.join(root, 'proc')], { [root]: MINOR, [path.join(root, 'proc')]: MINOR }));
  const driver = createRealMountDriver({ exec: localExec({ mountinfoFor: async () => mountinfo }) });
  const result = await driver.abortOwnConnection(4242, fusectl, MINOR, root);
  const written = await fs.readFile(path.join(fusectl, MINOR, 'abort'), 'utf8');
  await rmrf(dir);
  return { result, written };
}

describe('the real driver\'s abort', () => {
  test('writes nothing when the root is not attached on the minor, even with a fusectl entry for it', async () => {
    const { result, written } = await abortAgainst({ attached: false });
    assert.equal(written, '', 'the abort was written without the ownership check passing');
    assert.equal(result, 'not-mounted');
  });

  test('writes 1 when the root is attached on the minor', async () => {
    const { result, written } = await abortAgainst({ attached: true });
    assert.equal(written, '1');
    assert.equal(result, 'aborted');
  });

  test('maps each exit status to its result', async (t) => {
    const rows = [[0, 'aborted'], [3, 'not-mounted'], [4, 'no-entry'],
      // sudo's own refusal, the shell's failed redirect, and a command killed
      // or timed out before any exit.
      [1, 'failed'], [2, 'failed'], [null, 'failed']];
    for (const [status, expected] of rows) {
      await t.test(`${status} → ${expected}`, async () => {
        const driver = createRealMountDriver({ exec: async () => status });
        assert.equal(await driver.abortOwnConnection(4242, '/f', MINOR, '/r'), expected);
      });
    }
  });
});

describe('runStatus', () => {
  test('a command that exits reports its status', async (t) => {
    await t.test('0', async () => assert.equal(await runStatus('/bin/sh', ['-c', 'exit 0'], 5000), 0));
    await t.test('3', async () => assert.equal(await runStatus('/bin/sh', ['-c', 'exit 3'], 5000), 3));
  });

  test('a command that never reaches an exit is null', async (t) => {
    await t.test('timed out', async () => assert.equal(await runStatus('/bin/sh', ['-c', 'exec sleep 5'], 100), null));
    await t.test('killed by a signal', async () => assert.equal(await runStatus('/bin/sh', ['-c', 'kill -KILL $$'], 5000), null));
    await t.test('could not be started', async () => assert.equal(await runStatus('/nonexistent/cc-no-such-binary', [], 5000), null));
  });
});
