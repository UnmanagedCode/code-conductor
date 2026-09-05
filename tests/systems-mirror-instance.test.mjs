// CRITERION 1, AT THE LEVEL A USER EXPERIENCES IT: a real spawned session on a
// project whose provider mirrors more than the project tree.
//
// Every other wide-mirror test drives a HAND-CONSTRUCTED SessionRedirect, and
// composition is tested by calling composeSessionRoot directly. The two never
// met under an advertisement, which left the wiring between them — which of
// `root` and `cwd` becomes the CLI's working directory, and which becomes the
// prefix rule's anchor — held by nothing. They are two spellings of the same
// two values, so getting them backwards is silent: the pre-P7 spelling of
// either still composes a session, still spawns, and still reads project files
// that happen to exist at both addresses.
//
// So this file spawns an instance through the REST API and asks it, through its
// own redirect, for a file OUTSIDE the project tree. Nothing here is
// constructed by hand except the fixture's geometry.
//
// ORDERING NOTE: the behaviour landed two commits ago; there was nothing left
// to implement, so no test-first ordering was available or claimed. Its
// non-vacuity is structural and stated per assertion below: the image root is
// derived from sessionRootPath INDEPENDENTLY of the instance, so an instance
// whose cwd or whose map anchor is the wrong one of the pair fails rather than
// agreeing with itself.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { sessionRootPath } from '../src/systems/sessionRoot.ts';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mirrorFixtureProvider.mjs');

describe('a real session on a project whose provider mirrors above it', () => {
  let ctx, baseUrl, instances, home, inst, box, imageRoot;

  before(async () => {
    ctx = await bootServer();
    ({ baseUrl, instances } = ctx);
    ({ home } = await freshProjectsRoot());

    // The MIRROR ROOT is `box`; the project is one level inside it, and there is
    // a sibling directory the project tree does not contain. Both files carry a
    // system-side marker, so a read answered from cc's own disk would fail these
    // assertions rather than look right.
    box = await fs.realpath(await mkdtemp('cc-wide-'));
    await seedRepo(path.join(box, 'app'));
    await fs.writeFile(path.join(box, 'app', 'greeting.js'), 'SYSTEM-SIDE-PROJECT-FILE\n');
    await fs.mkdir(path.join(box, 'etc'), { recursive: true });
    await fs.writeFile(path.join(box, 'etc', 'config.toml'), 'SYSTEM-SIDE-OUTSIDE-FILE\n');

    await addSystem({
      id: 'wide', label: 'wide',
      launch: ['node', FIXTURE, '--advertise-mirror', box],
    });
    assert.equal((await adoptProject('app', path.join(box, 'app'), { system: 'wide' })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    // Derived from the session-root template, NOT from the instance — so the
    // assertions below compare the instance against an independent answer
    // instead of against itself.
    imageRoot = await fs.realpath(sessionRootPath('wide', 'app', null));
  });

  after(async () => {
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
  });

  const read = (filePath) => api(baseUrl, 'POST', `/api/instances/${inst.id}/hook-callback`, {
    session_id: 's',
    hook_event_name: 'PreToolUse',
    tool_use_id: `tu${Math.random()}`,
    tool_name: 'Read',
    tool_input: { file_path: filePath },
  });

  // PINS: the CLI's working directory is the project's place INSIDE the image,
  // not the image root — and the config surface is pulled there with it, so the
  // implicit reads the CLI makes from its cwd find it.
  //
  // NOT CLAIMING: that the CLI itself resolves anything from that directory;
  // this asserts where cc put it and what cc told the CLI to use.
  test('the session works one level inside the image, where its config surface is', async () => {
    assert.equal(inst.cwd, path.join(imageRoot, 'app'),
      'cwd is the project inside the image, not the image root');
    assert.equal(await fs.readFile(path.join(inst.cwd, 'CLAUDE.md'), 'utf8').then(() => 'here'), 'here');
    // And NOT at the image root, which is where it would be if the two values
    // had been swapped.
    await assert.rejects(fs.readFile(path.join(imageRoot, 'CLAUDE.md')),
      'the image root holds no config of its own');
  });

  // PINS CRITERION 1 END TO END: a file OUTSIDE the project tree is reachable
  // through a real session's own redirect, at its address in the image, and the
  // bytes are the system's.
  //
  // NOT CLAIMING: that it reached a different MACHINE — the fixture is
  // same-machine, and tests/systems-docker-boundary.real.test.mjs owns that with
  // a written sentinel. What this pins is that the map the running instance was
  // given spans the mirror, not the project.
  test('an out-of-project file is reachable through the running session', async () => {
    const local = path.join(imageRoot, 'etc', 'config.toml');
    const r = await read(local);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.hookSpecificOutput?.permissionDecision, 'allow',
      `out-of-project read must be allowed, got ${JSON.stringify(r.body)}`);
    assert.equal(await fs.readFile(local, 'utf8'), 'SYSTEM-SIDE-OUTSIDE-FILE\n');
  });

  // PINS: the project's own files still resolve to the PROJECT, not to the
  // mirror root. This is the half a swapped anchor breaks quietly — `<image>/
  // app/greeting.js` would map to `<box>/greeting.js`, a path that does not
  // exist, so the pull finds nothing rather than erroring.
  //
  // NOT CLAIMING: anything about Write or Edit; the push side is covered by
  // tests/systems-mirror-bridge.test.mjs.
  test('a project file still maps to the project, not to the mirror root', async () => {
    const local = path.join(imageRoot, 'app', 'greeting.js');
    const r = await read(local);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.hookSpecificOutput?.permissionDecision, 'allow', JSON.stringify(r.body));
    assert.equal(await fs.readFile(local, 'utf8'), 'SYSTEM-SIDE-PROJECT-FILE\n');
  });
});
