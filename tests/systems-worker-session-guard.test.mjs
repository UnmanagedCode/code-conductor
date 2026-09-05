// THE GUARD THAT DECIDES WHETHER A WORKER SESSION MAY EXIST ON A SYSTEM, and
// the one card 2026-0312 named as its own blocker.
//
// `isRedirectable` duck-types on a METHOD. Before that card it probed
// `openStream`, which the card deletes; it now probes `execOneShot`. The choice
// is load-bearing in BOTH directions and neither is checked by the compiler:
//
//   * `execOneShot` is declared on `ProviderSystem` and NOT on the base `System`
//     interface, so a bare `System` is correctly refused;
//   * re-basing it onto `exec` — which `System` DOES have — would make every
//     local project look redirectable, and that change PASSES TYPECHECK AND THE
//     WHOLE SUITE, because every system that reaches the guard in a test is a
//     `ProviderSystem` and has both methods.
//
// Which is why the assertions below are two-sided. A one-sided test ("a
// ProviderSystem is redirectable") passes for `() => true`; a one-sided negative
// passes for `() => false`.
//
// LIVE HANDLES, NOT STAND-INS, for the same reason tests/systemHandle.mjs
// exists: the classes are what the probe is about, and an object literal shaped
// like one would only re-assert the predicate's source text.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { adoptProject } from '../src/projects.ts';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { isRedirectable } from '../src/systems/toolRedirect.ts';

// ── T1: the probe itself, against both real classes ──────────────────

// PINS: `isRedirectable` answers TRUE for a live `ProviderSystem` and FALSE for
// a live `LocalSystem`.
//
// `new LocalSystem()` directly rather than `localSystem()`: under
// `npm run gate:systems` the registry's `local` IS a `ProviderSystem`, so the
// negative half would be asserting about the wrong class exactly where it
// matters most.
//
// NOT CLAIMING which method the probe uses — only what it answers. A future
// editor may re-base it on anything, provided both answers survive.
test('isRedirectable is true for a live ProviderSystem and false for a live LocalSystem', async () => {
  const { home } = await freshProjectsRoot();
  const remote = await bindRemoteSystem();
  try {
    const provider = await systemById(remote.id, null, 'test');
    assert.equal(isRedirectable(provider), true,
      'a provider-backed system can host a worker session');
    const local = new LocalSystem();
    assert.equal(isRedirectable(local), false,
      'cc own machine is not reached over the provider protocol, so it is not redirectable');

    // THE CONTROL FOR THE DECAY THIS TEST EXISTS TO CATCH, and it is a fact
    // about the two classes rather than about the predicate: `exec` is on BOTH,
    // so a probe re-based onto it cannot discriminate and would answer `true`
    // for cc's own machine. Measured on these same handles — `execOneShot`
    // true/false, `exec` true/true. If this assertion ever fails because
    // `LocalSystem` lost `exec`, the two-sided assertions above stop being
    // enough on their own and this comment is stale.
    assert.equal(typeof local.exec, 'function');
    assert.equal(typeof provider.exec, 'function',
      '`exec` is on both classes, so it can never be what the probe reads');
  } finally {
    disposeSystemHandles();
    await rmrf(home);
  }
});

// ── T2: the refusal the probe drives, at the surface a user meets ────

describe('a worker session on a system cc cannot run a command on', () => {
  let ctx, baseUrl, home, remote, tree;

  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // PINS THE USER-FACING REFUSAL, which had NO coverage at all before this test:
  // a project on a non-local system cc cannot run a command on is refused
  // 501 `WORKER_SESSIONS_NEED_A_SHELL`, and the same project on a healthy
  // provider spawns.
  //
  // BOTH HALVES IN ONE TEST, deliberately. The negative alone passes for a guard
  // that refuses everything — which is precisely the blocker card 2026-0312
  // named: deleting `openStream` without re-basing the probe refuses EVERY
  // worker session on EVERY remote project, and typecheck cannot see it because
  // the probe is a structural duck-type.
  //
  // THE STUB IS AN OWN PROPERTY ON THE LIVE HANDLE, not a fake class and not a
  // prototype mutation: post-strip every live non-local `System` is a
  // `ProviderSystem` and always has `execOneShot`, so the absent case is
  // unreachable without one. Shadowing the instance leaves every other handle
  // and every other test untouched, and `delete` restores the prototype method.
  //
  // NOT CLAIMING anything about the session that DOES spawn beyond its status —
  // what a redirected worker then does is tests/systems-remote-worker.test.mjs.
  test('is refused 501 WORKER_SESSIONS_NEED_A_SHELL, and one on a healthy provider spawns', async () => {
    const sys = await systemById(remote.id, null, 'test');
    assert.equal(typeof sys.execOneShot, 'function', 'the premise: a healthy handle has it');

    Object.defineProperty(sys, 'execOneShot', { value: undefined, configurable: true });
    try {
      const refused = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
      assert.equal(refused.status, 501, JSON.stringify(refused.body));
      assert.match(String(refused.body?.error ?? ''), /WORKER_SESSIONS_NEED_A_SHELL/,
        JSON.stringify(refused.body));
      assert.match(String(refused.body?.error ?? ''), /app/, 'and it names the project');
    } finally {
      delete sys.execOneShot;
    }

    // THE POSITIVE HALF, on the very same project and the very same handle: the
    // guard fires for the absent method and for nothing else.
    assert.equal(typeof sys.execOneShot, 'function', 'the handle is intact again');
    const spawned = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(spawned.status, 201, JSON.stringify(spawned.body));
    await api(baseUrl, 'DELETE', `/api/instances/${spawned.body.id}`);
  });
});
