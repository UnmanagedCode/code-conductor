// A RESUMED SESSION MUST NOT LAUNCH ON A ROOT THE TARGET CHECK DISCARDED.
//
// `composeSessionRoot` checks the target the root was pulled from BEFORE the
// root exists, and a mismatch removes the root and its manifest before the walk
// runs. `Instance._refreshSessionRoot` deliberately warns and carries on when a
// compose fails, because a briefly-unreachable system should cost a warning
// rather than a worker that cannot start — but behind a discarded root there is
// nothing left to carry on with, and the CLI would start in a directory holding
// none of the project's implicit config surface.
//
// WHICH ENTRY POINTS THIS IS ABOUT. Everything through `_doCreate` composes
// before `launch()` is reached and already refuses — a fresh spawn, a cold
// resume, a resume after restart. What is exposed is a RELAUNCH IN PLACE:
// respawn, rewind, prune recovery. The contrast is pinned here, in this file,
// so the refusal below cannot be read as covering create.
//
// WHICH failure fires is tests/systems-session-root.test.mjs's business; the
// mark is set by the target check and cannot tell them apart. This file injects
// one — the far side refusing to start `find`, the shape
// tests/systems-mid-operation-death.test.mjs already uses — and is about what
// the relaunch does with it.
//
// SAME-MACHINE TRAP. The reference provider is this machine spoken the long way
// round, so a composer aimed at the wrong path can look like success. Every
// assertion about the config surface below reads the cc-owned session root
// derived from `sessionRootPath(...)`, independently of the instance, while the
// project tree lives under a different temp prefix.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { liveSystemProto } from './systemHandle.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { sessionRootPath } from '../src/systems/sessionRoot.ts';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mirrorFixtureProvider.mjs');
const SYSTEM = 'movable';

describe('a relaunch whose compose discarded the session root', () => {
  let ctx, baseUrl, instances;
  before(async () => { ctx = await bootServer(); ({ baseUrl, instances } = ctx); });
  after(async () => { await ctx.close(); });

  let home, tree, mirrorFile, pidFile, inst;
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    tree = await fs.realpath(await mkdtemp('cc-discard-tree-'));
    await seedRepo(tree);

    const box = await mkdtemp('cc-discard-box-');
    mirrorFile = path.join(box, 'mirror');
    pidFile = path.join(box, 'pid');
    // Starts empty: the provider advertises nothing, so the first composition
    // is the ordinary project-anchored one and the manifest records it.
    await fs.writeFile(mirrorFile, '');
    await addSystem({
      id: SYSTEM, label: SYSTEM,
      launch: ['node', FIXTURE, '--mirror-file', mirrorFile, '--pid-file', pidFile],
    });
    assert.equal((await adoptProject('app', tree, { system: SYSTEM })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
  });
  afterEach(async () => {
    await instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  // The cc-owned session root, addressed the way the store addresses it rather
  // than the way the instance remembers it.
  const ownRoot = () => fs.realpath(sessionRootPath(SYSTEM, 'app', null));

  // A NEW CONNECTION GENERATION answering with a different mirror root — the
  // only thing that can move the geometry under a live session, and the organic
  // way to make the next compose's target check not hold.
  async function moveTheMirror() {
    await fs.writeFile(mirrorFile, path.dirname(tree));
    const system = inst._redirectPlacement.system;
    const generation = system.handshake;
    const gone = Number(await fs.readFile(pidFile, 'utf8'));
    // The fixture IS the provider — one process, no child to orphan.
    process.kill(gone, 'SIGKILL');
    await waitFor(() => { try { process.kill(gone, 0); return false; } catch { return true; } });
    // The exit has to be OBSERVED before the reconnect, or `ensureUp` hands back
    // the handshake of a process that is already gone.
    await waitFor(() => system.handshake === null);
    await system.connect();
    assert.notEqual(system.handshake, generation, 'a new connection generation really began');
  }

  // `find` answered with "that command never started". Scoped to `find`, so
  // everything else on this system keeps working — the point is a failed WALK,
  // not an unreachable machine.
  async function withFailingWalk(body) {
    const proto = liveSystemProto(inst._redirectPlacement.system);
    const orig = proto.exec;
    proto.exec = async function (spec, opts) {
      if (spec?.argv?.[0] === 'find') {
        return {
          code: 0, stdout: '', stderr: '', output: '',
          timedOut: false, truncated: false, durationMs: 1, spawnError: 'refused: ENOENT',
        };
      }
      return orig.call(this, spec, opts);
    };
    try { return await body(); } finally { proto.exec = orig; }
  }

  // Every stderr line one call put on the session's event stream.
  async function linesFrom(fn) {
    const seen = [];
    const real = inst._emitUi.bind(inst);
    inst._emitUi = (ev) => {
      if (ev.kind === 'system' && ev.subtype === 'stderr') seen.push(ev.data.line);
      return real(ev);
    };
    try { return { out: await fn(), seen }; } finally { inst._emitUi = real; }
  }

  const stopped = async () => {
    await inst.kill({ graceMs: 200 });
    await waitFor(() => inst.proc === null);
  };

  // PINS: a relaunch in place whose compose failed after the target check
  // discarded the root REFUSES — it rejects 502 `SESSION_ROOT_DISCARDED`, no
  // worker process is started, and the warning still reaches the session's own
  // event stream where an operator watching it is looking.
  //
  // NOT CLAIMING that the root is empty — tests/systems-session-root.test.mjs
  // owns that, and the refusal is set by the check rather than by inspecting
  // the root. NOT CLAIMING anything about the real CLI either: the point is
  // that no CLI is started at all.
  test('a resumed session whose compose discarded the root does not launch', async () => {
    await moveTheMirror();
    await stopped();

    const { seen } = await linesFrom(() => withFailingWalk(() => assert.rejects(
      () => instances.respawn(inst.id),
      (e) => {
        assert.equal(e.statusCode, 502, e.message);
        assert.equal(e.code, 'SESSION_ROOT_DISCARDED', e.message);
        return true;
      },
    )));

    assert.equal(inst.proc, null, 'no worker was started');
    assert.ok(seen.some(l => l.includes('could not refresh the session root')),
      `the cause still reached the session's stream: ${JSON.stringify(seen)}`);
  });

  // CONTRAST, green before and after this card. PINS: the create path refuses
  // the same intersection on its own, and registers no instance — so the test
  // above is not what covers create, and a reader cannot mistake one for the
  // other.
  //
  // NOT CLAIMING that the two refusals share a shape: create's is the compose's
  // own error, and the relaunch's is a refusal composed where the policy lives.
  test('CONTRAST: the create path refuses the same intersection by itself', async () => {
    await moveTheMirror();
    const registered = instances.byId.size;

    const r = await withFailingWalk(
      () => api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' }),
    );
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal(instances.byId.size, registered, 'and no instance was registered for it');
  });

  // CONTROL, green before and after this card. PINS: the SAME walk failure with
  // the target check HOLDING still resumes — the process comes back, the last
  // good root is still there to run in, and it cost exactly one warning. This
  // is what the refusal above must not swallow: card 2026-0267's warn-and-carry-
  // on for a system that is briefly unreachable.
  //
  // NOT CLAIMING that the config surface is FRESH. It is the last good one, and
  // that is the whole trade.
  test('CONTROL: a briefly unreachable system still resumes on its last good root', async () => {
    const root = await ownRoot();
    assert.ok(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8'),
      'there is a last-good root to resume on');
    await stopped();

    const { seen } = await linesFrom(() => withFailingWalk(() => instances.respawn(inst.id)));

    assert.notEqual(inst.proc, null, 'the worker came back');
    assert.ok(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8'),
      'on the root the failed compose left alone');
    assert.deepEqual(seen.filter(l => l.includes('could not refresh the session root')).length, 1,
      `and it cost exactly one warning: ${JSON.stringify(seen)}`);
  });
});
