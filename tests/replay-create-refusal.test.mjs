// A replay's InstanceManager (`refuseCreates`, src/instances.ts) answers every
// create() with the refusal and never reaches the launcher, so nothing in cc can
// start a session CLI during a `--view` replay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager } from '../src/instances.ts';
import { VIEW_NO_LAUNCH } from '../src/headless/view.ts';

function launcherCounting() {
  const calls = [];
  const launcher = { spawn: (...a) => { calls.push(a); throw new Error('launcher reached'); } };
  return { launcher, calls };
}

for (const [name, opts] of [['a new session', {}], ['a resume', { resume: 'some-session' }]]) {
  test(`create() of ${name} is refused 409 with the replay code, before the launcher`, async () => {
    const { launcher, calls } = launcherCounting();
    const m = new InstanceManager({ claudeLauncher: launcher, refuseCreates: VIEW_NO_LAUNCH });
    await assert.rejects(m.create(opts), (e) => e.statusCode === 409 && e.code === 'VIEW_REPLAY_NO_LAUNCH' && e.message === VIEW_NO_LAUNCH.message);
    assert.equal(calls.length, 0, 'the launcher was never called');
  });
}

// Positive control: without the option the same calls fail on their own merits
// (no such session), not with the replay refusal.
for (const [name, opts] of [['a new session', {}], ['a resume', { resume: 'some-session' }]]) {
  test(`without refuseCreates, create() of ${name} does not answer the replay refusal`, async () => {
    const { launcher } = launcherCounting();
    const m = new InstanceManager({ claudeLauncher: launcher });
    await assert.rejects(m.create(opts), (e) => e.code !== 'VIEW_REPLAY_NO_LAUNCH');
  });
}
