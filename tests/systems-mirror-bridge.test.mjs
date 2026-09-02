// CRITERION 1: an out-of-project file on the system, read, edited and pushed
// back — with no new fetch mechanism.
//
// The file bridge was already a cacheless, per-op, on-demand pull-then-push
// (src/systems/fileBridge.ts); nothing in it was project-scoped except the path
// map it is handed. So this file is not about new machinery. It is about the
// consequences of widening that map: a path OUTSIDE the project tree now has a
// local counterpart, and everything the bridge promises must still hold for it.
//
// THE SAME-MACHINE TRAP. The reference provider runs on cc's own filesystem, so
// a wrong-target bug looks exactly like success — and a wide mirror makes the
// path overlap total rather than incidental. Every write-back below is verified
// by reading the file back THROUGH THE PROVIDER, and the fixture's system tree
// lives outside PROJECTS_ROOT so a bridge that used cc's own copy would fail
// rather than pass. What that still cannot prove is that the bytes reached a
// different MACHINE; tests/systems-docker-boundary.real.test.mjs closes that.
//
// D-P7-10 form: not applicable — no assertion here is of the "identical to
// today" kind.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { SessionPathMap } from '../src/systems/sessionRoot.ts';
import { SessionRedirect } from '../src/systems/toolRedirect.ts';

describe('a mirror wider than the project', () => {
  let home, remote, sys, box, project, image, redirect, events;

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    sys = await systemById(remote.id, null, 'test');
    // The mirrored address space, with the project one level inside it and a
    // sibling directory that is NOT part of the project.
    box = remote.root;
    project = path.join(box, 'app');
    await fs.mkdir(path.join(box, 'etc'), { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(box, 'etc', 'config.toml'), 'mode = "old"\n');
    await fs.writeFile(path.join(project, 'main.js'), 'console.log(1)\n');

    image = path.join(home, 'image');
    await fs.mkdir(path.join(image, 'app'), { recursive: true });
    events = [];
    redirect = new SessionRedirect({
      system: sys, systemId: remote.id,
      systemPath: project, sessionRoot: image,
      mirror: { mirrorRoot: box, exclude: [], offset: 'app' },
      forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
      localRoots: [],
      emit: (ev) => events.push(ev),
    });
  });
  afterEach(async () => { await redirect.close(); disposeSystemHandles(); await rmrf(home); });

  const inImage = (rel) => path.join(image, rel);
  const pre = (tool, input) => redirect.preToolUse(tool, input);
  const post = (tool, input) => redirect.postToolUse(tool, input, {});
  // The only witness this file trusts about the system's state.
  const onSystem = (rel) => sys.readFile(path.join(box, rel));

  // PINS CRITERION 1 END TO END: a file outside the project tree is pulled on
  // Read, edited at its local counterpart, and pushed back — with the result
  // read back through the provider, not off cc's disk.
  //
  // NOT CLAIMING: that it reached a different machine. The reference provider is
  // same-machine; the docker suite makes that assertion.
  test('a file outside the project is pulled, edited and pushed back', async () => {
    const local = inImage('etc/config.toml');
    assert.equal((await pre('Read', { file_path: local })).decision, 'allow');
    assert.equal(await fs.readFile(local, 'utf8'), 'mode = "old"\n', 'the pull materialised it locally');

    assert.equal((await pre('Edit', { file_path: local, old_string: 'old', new_string: 'new' })).decision, 'allow');
    await fs.writeFile(local, 'mode = "new"\n');
    const note = await post('Edit', { file_path: local });
    assert.equal(note, `Saved to ${path.join(box, 'etc/config.toml')} on system '${remote.id}'.`);
    assert.equal(await onSystem('etc/config.toml'), 'mode = "new"\n');
  });

  // PINS: the pull→edit→push round trip PRESERVES MODE for an out-of-project
  // file. The push ends in a rename, which would otherwise hand an edited script
  // a fresh 0644 and silently stop it being executable.
  //
  // NOT CLAIMING: anything about ownership or extended attributes; cc carries
  // text and a mode, and says so.
  test('an executable outside the project stays executable across the round trip', async () => {
    const remoteScript = path.join(box, 'bin', 'run.sh');
    await fs.mkdir(path.dirname(remoteScript), { recursive: true });
    await fs.writeFile(remoteScript, '#!/bin/sh\necho one\n');
    await fs.chmod(remoteScript, 0o755);

    const local = inImage('bin/run.sh');
    await pre('Read', { file_path: local });
    await pre('Edit', { file_path: local, old_string: 'one', new_string: 'two' });
    await fs.writeFile(local, '#!/bin/sh\necho two\n');
    await post('Edit', { file_path: local });

    assert.equal(await onSystem('bin/run.sh'), '#!/bin/sh\necho two\n');
    assert.equal((await sys.stat(remoteScript)).mode & 0o777, 0o755);
  });

  // PINS: a failed push to an OUT-OF-PROJECT path is as loud and as sticky as
  // one inside it — the divergence is named on the result, raised to the
  // operator, and the next write to that path is refused naming the file.
  //
  // NOT CLAIMING: that divergence survives a process restart. The marker is
  // in-memory by design.
  test('a failed push to an out-of-project path is named and sticks', async () => {
    const local = inImage('etc/config.toml');
    await pre('Read', { file_path: local });
    await fs.writeFile(local, 'mode = "local only"\n');
    // Break the push: the parent becomes a file on the system.
    await fs.rm(path.join(box, 'etc'), { recursive: true });
    await fs.writeFile(path.join(box, 'etc'), 'not a directory\n');

    const note = await post('Edit', { file_path: local });
    assert.match(note, /WRITE-BACK FAILED/);
    assert.ok(note.includes(path.join(box, 'etc/config.toml')), note);
    assert.ok(events.some(e => JSON.stringify(e).includes('did not reach')),
      'the operator hears about it too');

    const denied = await pre('Edit', { file_path: local, old_string: 'x', new_string: 'y' });
    assert.equal(denied.decision, 'deny');
    assert.ok(denied.reason.includes(local), denied.reason);
  });

  // PINS: there is no read cache to go stale. A file changed on the system
  // between the Read and the Edit is re-pulled BEFORE the Edit runs, which is
  // what makes the mixed `sed -i`-then-Edit case safe.
  //
  // NOT CLAIMING: that the CLI emits its own advisory staleness note; that is
  // CLI surface, covered by the gated real-CLI suite.
  test('a file changed on the system between Read and Edit is re-pulled', async () => {
    const local = inImage('etc/config.toml');
    await pre('Read', { file_path: local });
    assert.equal(await fs.readFile(local, 'utf8'), 'mode = "old"\n');

    // Something else — a Bash `sed -i`, in the real case — moves the far side.
    await sys.writeFile(path.join(box, 'etc', 'config.toml'), 'mode = "changed under us"\n');

    await pre('Edit', { file_path: local, old_string: 'changed', new_string: 'changed' });
    assert.equal(await fs.readFile(local, 'utf8'), 'mode = "changed under us"\n',
      'the Edit sees the fresh bytes, not the ones the Read left');
  });

  // PINS: the map is INJECTIVE — the local path in the image IS the cache
  // identity, and two distinct system paths can never collide on one local
  // path. There is no key beyond the path, so this property is the whole of the
  // cache-identity question.
  //
  // NOT CLAIMING: that a symlink on the system cannot make two system paths name
  // one file. The map is about paths; the atomic write is what keeps a link from
  // being written through.
  test('two system paths never collide on one local path', () => {
    const map = new SessionPathMap('/img', '/mirror');
    const seen = new Map();
    const systemPaths = [
      '/mirror', '/mirror/app', '/mirror/app/a.js', '/mirror/etc/a.js',
      '/mirror/etc', '/mirror/etc-backup', '/mirror/a b/c', '/mirror/x/../y',
    ];
    for (const p of systemPaths) {
      const local = map.toLocal(p);
      if (local === null) continue;
      assert.ok(!seen.has(local), `${p} and ${seen.get(local)} both map to ${local}`);
      seen.set(local, p);
      // And the round trip is the identity on the normalised form.
      assert.equal(map.toSystem(local), path.posix.normalize(p));
    }
    assert.ok(seen.size >= 7, 'the fixture really exercised the map');
  });

  // PINS `SessionRedirect.retarget`, the ONE way a live session's geometry
  // changes (card 2026-0279): the prefix rule moves to the new mirror root and
  // the project root moves with the new offset, while the IMAGE root — which
  // `sessionRootPath` keys on project/worktree only — does not move at all. A
  // system path that was addressable before is still addressable after, at the
  // local path the new geometry gives it.
  //
  // NOT CLAIMING that the local BYTES survived: `resetRoot` deletes the whole
  // image root before a real retarget runs, and the bridge pulls before every
  // op. NOT CLAIMING anything about the far-side shells — they run at
  // `systemPath`, which does not move, and `retarget` does not touch them.
  test('retarget moves the prefix rule, and a path that was addressable stays addressable', async () => {
    const wasLocal = inImage('app/main.js');
    const systemPath = redirect.map.toSystem(wasLocal);
    assert.equal(systemPath, path.join(project, 'main.js'));
    assert.equal(redirect.projectRoot, inImage('app'));

    // The narrowing an advertisement that stops mirroring the shared box would
    // produce: same image root, mirror root now the project itself, offset ''.
    redirect.retarget(image, { mirrorRoot: project, exclude: [], offset: '' });

    assert.equal(redirect.map.root, image, 'the image root moved');
    assert.equal(redirect.map.mirrorRoot, project);
    assert.equal(redirect.projectRoot, image, 'the project is now the image root itself');
    assert.equal(redirect.map.toLocal(systemPath), inImage('main.js'),
      'the same system path is not addressable under the new geometry');
    assert.equal(redirect.map.toSystem(inImage('main.js')), systemPath, 'and the round trip still holds');
    // The out-of-project sibling is outside the narrowed mirror, so it is no
    // longer addressable — the new geometry is narrower, and says so.
    assert.equal(redirect.map.toLocal(path.join(box, 'etc', 'config.toml')), null);
    // And the exclude list comes from the SAME advertisement as the root: two
    // sources for one scope is how a boundary gets decided two different ways.
    redirect.retarget(image, { mirrorRoot: box, exclude: [path.join(box, 'etc')], offset: 'app' });
    assert.equal(redirect.map.classify(inImage('etc/config.toml')).kind, 'excluded');
  });

  // PINS: the project's OWN files still work exactly as before under a wider
  // mirror — the widening adds reach, it does not move the project.
  //
  // NOT CLAIMING: that the geometry is identical to the unadvertised case; it
  // is not, and tests/systems-mirror-fallback.test.mjs owns that case.
  test('the project\'s own files still pull and push at their place in the image', async () => {
    const local = inImage('app/main.js');
    assert.equal(redirect.projectRoot, inImage('app'));
    await pre('Read', { file_path: local });
    assert.equal(await fs.readFile(local, 'utf8'), 'console.log(1)\n');
    await fs.writeFile(local, 'console.log(2)\n');
    assert.match(await post('Edit', { file_path: local }), /app\/main\.js/);
    assert.equal(await onSystem('app/main.js'), 'console.log(2)\n');
  });
});
