// A replay's InstanceManager (`refuseCreates`, src/instances.ts) answers every
// create() with the refusal and never reaches the launcher, so nothing in cc can
// start a session CLI during a `--view` replay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, registerLocalProject, rmrf } from './helpers.mjs';
import { InstanceManager } from '../src/instances.ts';
import { VIEW_NO_LAUNCH } from '../src/headless/view.ts';

// InstanceManager reaches its launcher through launch(input). The marker error ends a create() that gets that far.
function launcherCounting() {
  const calls = [];
  const launcher = { launch: (input) => { calls.push(input); throw new Error('launcher reached'); } };
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

// Positive control: without the option a new session's create() reaches launch() (and only the marker stops it),
// so the zero above is the refusal's doing.
test('without refuseCreates, create() of a new session reaches the launcher', async (t) => {
  const { launcher, calls } = launcherCounting();
  const m = new InstanceManager({ claudeLauncher: launcher });
  const { home, projectsRoot } = await freshProjectsRoot();
  t.after(() => rmrf(home));
  fs.mkdirSync(path.join(projectsRoot, 'p'), { recursive: true });
  await registerLocalProject('p', path.join(projectsRoot, 'p'));
  await assert.rejects(m.create({ project: 'p' }), /launcher reached/);
  assert.equal(calls.length, 1);
});
