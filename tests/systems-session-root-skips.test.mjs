// THE ENTRY CAP'S SKIP REACHING THE SESSION.
//
// `composeSessionRoot` returns `skipped[]`; what makes a skip actionable is that
// somebody sees it. There is exactly ONE emit site — `Instance._refreshSessionRoot`
// — and a fresh spawn reaches it only because `launch()` composes a SECOND time:
// `_doCreate`'s own compose reads `.cwd`/`.root`/`.mirror` off the result and
// discards `skipped[]` entirely. Nothing in the repo pinned that line before this
// file (card 2026-0274).
//
// ITS OWN FILE rather than an append to tests/systems-session-root.test.mjs:
// `tests/run.mjs` runs files in parallel, so a whole `bootServer()` costs less
// wall clock beside that file than added to it, and no existing file owns this
// claim.
//
// SAME-MACHINE TRAP. The reference provider is this machine spoken the long way
// round, so the project tree deliberately lives under a temp prefix that is not
// inside PROJECTS_ROOT — a composer that read cc's own disk would find nothing
// there rather than accidentally succeeding.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { adoptProject } from '../src/projects.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

// The cap written out rather than imported, and the fixture below is sized to
// CROSS it — so raising the cap turns this test red, which is intended.
const ENTRY_CAP = 2000;

describe("a spawn whose config surface overruns the entry cap", () => {
  let ctx, baseUrl, instances, home, remote, lines;

  before(async () => {
    ctx = await bootServer();
    ({ baseUrl, instances } = ctx);
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    await seedRepo(remote.root);
    await fs.writeFile(path.join(remote.root, 'CLAUDE.md'), '@CONVENTIONS.md\nnotes\n');
    await fs.writeFile(path.join(remote.root, 'CONVENTIONS.md'), 'rules\n');
    const dir = path.join(remote.root, '.claude/skills/bulk');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < ENTRY_CAP + 10; i += 64) {
      await Promise.all(Array.from({ length: Math.min(64, ENTRY_CAP + 10 - i) }, (_, k) => (
        fs.writeFile(path.join(dir, `f${String(i + k).padStart(6, '0')}.md`), 'x')
      )));
    }
    assert.equal((await adoptProject('app', remote.root, { system: remote.id })).ok, true);

    // Subscribed to the MANAGER's stream before the instance exists, because the
    // line under test is emitted during create — the per-instance forwarder is
    // wired before `launch()` runs, so nothing is missed.
    lines = [];
    instances.on('event', ({ ev }) => {
      if (ev.kind === 'system' && ev.subtype === 'stderr') lines.push(ev.data.line);
    });

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await waitFor(() => instances.get(r.body.id).status === 'idle');
  });

  after(async () => {
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
  });

  // PINS: the entry cap's one summarised skip reaches a spawned session as a
  // single `system`/`stderr` line — the channel that makes "skip and NAME"
  // different from a silent truncation — and the session still reaches idle.
  //
  // NOT CLAIMING the relaunch path: it goes through the same single emit site,
  // and paying for it twice would buy nothing.
  //
  // NOT CLAIMING that the create path emits it in its own right. It does not —
  // `_doCreate`'s compose discards `skipped[]`, and this line exists only
  // because `launch()` composes again. An optimisation that removed that second
  // compose would take every skip line off the create path silently, and the
  // comment justifying it names other grounds entirely.
  test('the entry cap skip arrives as exactly one stderr line at a fresh spawn', () => {
    const capLines = lines.filter(l => /session root skipped .* 2000-entry session-root cap/.test(l));
    assert.equal(capLines.length, 1, `exactly one cap line; got ${JSON.stringify(lines)}`);
    assert.match(capLines[0], /so 10 further entries were not pulled \(\.claude\/skills 10\)/);
  });
});
