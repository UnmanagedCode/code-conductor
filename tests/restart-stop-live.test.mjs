// scheduleRestart must stop live non-temp instances where SIGTERM is not soft
// (stopLiveSync), or the CLI's children outlive the exit.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstanceManager } from '../src/instances.ts';
import { posixPlatform } from '../src/platform/posix.ts';
import { scheduleRestart } from '../src/restart.ts';

async function restartWith(platform) {
  const mgr = new InstanceManager({ platform });
  mgr._usageMonitor.stop();
  let ended = 0;
  mgr.byId.set('a', { proc: { stdin: { end() { ended++; } } }, pid: process.pid, temp: false, _fuse: null, interruptTurnForStop() {} });

  // The replacement is a real spawn of `node <argv[1]>`: point it at a no-op.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-restart-'));
  const script = path.join(dir, 'noop.mjs');
  await fs.writeFile(script, '');
  const argv1 = process.argv[1];
  process.argv[1] = script;
  const exit = mock.method(process, 'exit', () => {});
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => (now += 1000); // the sync wait elapses at once
  try {
    scheduleRestart({ instances: mgr, log: { warn() {}, log() {}, error() {} } });
  } finally {
    Date.now = realNow;
    process.argv[1] = argv1;
  }
  await new Promise(r => setTimeout(r, 120));
  exit.mock.restore();
  await fs.rm(dir, { recursive: true, force: true });
  return ended;
}

test('scheduleRestart ends stdin of live instances when SIGTERM is not soft', async () => {
  const kills = [];
  const ended = await restartWith({ ...posixPlatform, softSigterm: false, killProcess: (t, s) => kills.push([t, s]) });
  assert.equal(ended >= 1, true, 'stopLiveSync reached the instance');
  assert.deepEqual(kills, [[process.pid, 'SIGKILL']], 'a survivor is tree-killed');
});

test('scheduleRestart leaves live instances to exit on EOF where SIGTERM is soft', async () => {
  const kills = [];
  const ended = await restartWith({ ...posixPlatform, killProcess: (t, s) => kills.push([t, s]) });
  assert.deepEqual(kills, []);
  assert.equal(ended, 0);
});
