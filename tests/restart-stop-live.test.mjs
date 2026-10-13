// A plain restart's teardownInstances must stop live non-temp instances where
// SIGTERM is not soft (stopLiveSync), or the CLI's children outlive the exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager } from '../src/instances.ts';
import { posixPlatform } from '../src/platform/posix.ts';
import { teardownInstances } from '../src/restart.ts';

async function restartWith(platform) {
  const mgr = new InstanceManager({ platform });
  mgr._usageMonitor.stop();
  let ended = 0;
  mgr.byId.set('a', { proc: { stdin: { end() { ended++; } } }, pid: process.pid, temp: false, _fuse: null, interruptTurnForStop() {} });
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => (now += 1000); // the sync wait elapses at once
  try {
    teardownInstances({ instances: mgr, log: { warn() {}, log() {}, error() {} } });
  } finally {
    Date.now = realNow;
  }
  await new Promise(r => setTimeout(r, 20));
  return ended;
}

test('teardownInstances ends stdin of live instances when SIGTERM is not soft', async () => {
  const kills = [];
  const ended = await restartWith({ ...posixPlatform, softSigterm: false, killProcess: (t, s) => kills.push([t, s]) });
  assert.equal(ended >= 1, true, 'stopLiveSync reached the instance');
  assert.deepEqual(kills, [[process.pid, 'SIGKILL']], 'a survivor is tree-killed');
});

test('teardownInstances leaves live instances to exit on EOF where SIGTERM is soft', async () => {
  const kills = [];
  const ended = await restartWith({ ...posixPlatform, killProcess: (t, s) => kills.push([t, s]) });
  assert.deepEqual(kills, []);
  assert.equal(ended, 0);
});
