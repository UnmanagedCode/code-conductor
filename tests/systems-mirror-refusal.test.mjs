// CRITERIA 5 AND 6: what a worker is TOLD about an excluded path, and that the
// channel the refusal points at actually works.
//
// The excluded-path refusal is read once, mid-task, by a model deciding whether
// a file exists. The failure mode it exists to prevent is precise: if the model
// can mistake it for file-not-found, it concludes the file is absent instead of
// using the channel that works. So the assertions below are about the PROPERTIES
// the reasoning depends on — cc names itself as the actor, names the prefix so
// the model generalises, states twice that this is not absence, and offers Bash
// with concrete verbs — rather than about a golden blob. A future re-wording is
// free to change phrasing; it is not free to re-introduce the ENOENT reading.
//
// D-P7-10 form: not applicable — nothing here is an "identical to today"
// assertion. The refusal properties are hand-written literals.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { FILE_TOOLS, SessionRedirect } from '../src/systems/toolRedirect.ts';

// The phrases a model reads as "the file is not there". None of them may appear.
const ENOENT_READINGS = [/not found/i, /does not exist/i, /no such file/i, /\bmissing\b/i];

describe('an excluded path, and the channel that still reaches it', () => {
  let home, remote, sys, box, project, image, secret, redirect, localOk;

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    sys = await systemById(remote.id, null, 'test');
    box = remote.root;
    project = path.join(box, 'app');
    secret = path.join(box, 'secret');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(secret, 'deep'), { recursive: true });
    await fs.writeFile(path.join(secret, 'token'), 'hunter2\n');
    await fs.writeFile(path.join(secret, 'deep', 'nested'), 'deeper\n');
    await fs.writeFile(path.join(project, 'main.js'), 'console.log(1)\n');

    image = path.join(home, 'image');
    localOk = path.join(home, 'local-ok');
    await fs.mkdir(path.join(image, 'app'), { recursive: true });
    await fs.mkdir(localOk, { recursive: true });
    redirect = new SessionRedirect({
      system: sys, systemId: remote.id,
      systemPath: project, sessionRoot: image,
      mirror: { mirrorRoot: box, exclude: [secret], offset: 'app' },
      forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
      localRoots: [localOk],
      emit: () => {},
    });
  });
  afterEach(async () => { await redirect.close(); disposeSystemHandles(); await rmrf(home); });

  const pre = (tool, input) => redirect.preToolUse(tool, input);

  // PINS CRITERION 6, as properties of the string: cc names itself as the
  // actor, names the excluded PREFIX (so the model generalises rather than
  // retrying sibling by sibling), says twice that this is a refusal and not
  // absence, points at Bash with concrete verbs — and contains not one phrase a
  // model reads as file-not-found.
  //
  // NOT CLAIMING: that a model INTERPRETS it correctly. That is unmeasurable
  // here. It pins the properties the card's reasoning rests on.
  test('the excluded-path refusal cannot be read as file-not-found', async () => {
    const d = await pre('Read', { file_path: path.join(image, 'secret/deep/nested') });
    assert.equal(d.decision, 'deny');
    const r = d.reason;

    assert.ok(r.includes('cc will not bridge'), r);
    assert.ok(r.includes('NOT the file being absent'), r);
    assert.ok(r.includes('cc has not looked'), r);
    assert.ok(r.includes(secret), 'it names the excluded PREFIX');
    assert.ok(r.includes(path.join(box, 'secret/deep/nested')), 'and the path asked for');
    assert.ok(r.includes(remote.id), 'and the system');
    assert.ok(/\bBash\b/.test(r), 'it names Bash');
    assert.ok(r.includes('cat') && r.includes('sed -i'), 'with concrete verbs for both directions');
    for (const bad of ENOENT_READINGS) {
      assert.ok(!bad.test(r), `the refusal must not read as absence: ${bad} matched ${JSON.stringify(r)}`);
    }
  });

  // PINS: the refusal covers EVERY tool whose path this module owns — the
  // FILE_TOOLS map, not a hand-picked three — so a fifth file tool added later
  // fails this test rather than silently escaping the exclusion.
  //
  // NOT CLAIMING: anything about Glob/Grep, which are removed outright.
  test('every file tool is refused on an excluded path, reads and writes alike', async () => {
    const excluded = path.join(image, 'secret/token');
    // ENUMERATED FROM THE MAP, not transcribed: a fifth file tool added to
    // FILE_TOOLS is covered here the moment it is added, or fails.
    const tools = Object.entries(FILE_TOOLS);
    assert.ok(tools.length >= 4, 'the map really has the tools this claim is about');
    for (const [tool, key] of tools) {
      const d = await pre(tool, { [key]: excluded, content: 'x', old_string: 'a', new_string: 'b', new_source: 'x' });
      assert.equal(d.decision, 'deny', tool);
      assert.ok(d.reason.includes('cc will not bridge'), `${tool}: ${d.reason}`);
    }
    // The exclusion is a subtree, and a prefix-SHARING sibling is NOT in it.
    await fs.mkdir(path.join(box, 'secretive'), { recursive: true });
    await fs.writeFile(path.join(box, 'secretive/ok.txt'), 'fine\n');
    assert.equal((await pre('Read', { file_path: path.join(image, 'secretive/ok.txt') })).decision, 'allow');
  });

  // PINS CRITERION 5: Bash reaches the same path under no such restriction, in
  // the very fixture that refuses Read/Write/Edit on it — read AND write, since
  // the refusal offers both. Verified through the provider, not off cc's disk.
  //
  // NOT CLAIMING: that Bash is unconstrained in general. It asserts the one case
  // the exclude list would have bound.
  test('Bash reads and writes the excluded path the file tools refused', async () => {
    const target = path.join(secret, 'token');
    const read = await redirect.runForwarded(`cat ${target}`, {});
    assert.equal(read.code, 0, read.stderr);
    assert.equal(read.stdout, 'hunter2\n');

    const write = await redirect.runForwarded(`printf 'rotated\\n' > ${target}`, {});
    assert.equal(write.code, 0, write.stderr);
    assert.equal(await sys.readFile(target), 'rotated\n');

    const sed = await redirect.runForwarded(`sed -i s/rotated/again/ ${target}`, {});
    assert.equal(sed.code, 0, sed.stderr);
    assert.equal(await sys.readFile(target), 'again\n');

    // And the file tools still refuse it afterwards — the exclusion is policy,
    // not a consequence of the file's state.
    assert.equal((await pre('Read', { file_path: path.join(image, 'secret/token') })).decision, 'deny');
  });

  // PINS CRITERION 8: the out-of-boundary refusal is derived from the SAME two
  // fields the mirroring is, so the refusal boundary and the mirror boundary
  // cannot drift — and when the path a worker named does have a counterpart, the
  // refusal TRANSLATES rather than merely declining.
  //
  // NOT CLAIMING: that `localRoots` is correctly populated. src/instances.ts
  // owns that list.
  test('a system path a worker names is translated to the local one it can use', async () => {
    const d = await pre('Read', { file_path: path.join(project, 'main.js') });
    assert.equal(d.decision, 'deny');
    assert.ok(d.reason.includes(project), 'it still names the project tree');
    assert.ok(d.reason.includes(`reaches that same file at ${path.join(image, 'app/main.js')}`), d.reason);

    // A path with no counterpart at all gets the base refusal and no invented
    // translation.
    const far = await pre('Read', { file_path: path.join(os.tmpdir(), 'cc-nowhere.txt') });
    assert.equal(far.decision, 'deny');
    assert.ok(!far.reason.includes('reaches that same file at'), far.reason);
  });

  // PINS THE ORDERING HAZARD a wide mirror introduces: a path cc KNOWS is local
  // — an attachment, a `~/.claude` plan — is tested before the translating
  // refusal, so it is allowed through and never handed a system path. Reversing
  // those two lines would send a read of cc's own file to the far side.
  //
  // NOT CLAIMING: which paths belong on localRoots.
  test('a known-local path is allowed, never translated, even under a wide mirror', async () => {
    const attachment = path.join(localOk, 'note.txt');
    await fs.writeFile(attachment, 'from the user\n');
    const d = await pre('Read', { file_path: attachment });
    assert.equal(d.decision, 'allow', JSON.stringify(d));

    // Widen to `/`, where EVERY absolute path has a local counterpart — the
    // configuration in which the ordering is the only thing that saves this.
    const widest = new SessionRedirect({
      system: sys, systemId: remote.id,
      systemPath: project, sessionRoot: image,
      mirror: { mirrorRoot: '/', exclude: [], offset: project.replace(/^\//, '') },
      forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
      localRoots: [localOk],
      emit: () => {},
    });
    try {
      assert.ok(widest.map.toLocal(attachment) !== null,
        'the premise: under `/` even cc\'s own attachment has a counterpart');
      assert.equal((await widest.preToolUse('Read', { file_path: attachment })).decision, 'allow');
      assert.equal((await widest.preToolUse('Write', { file_path: attachment, content: 'x' })).decision, 'allow');
    } finally { await widest.close(); }
  });
});
