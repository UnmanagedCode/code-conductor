// TWO PLACES, ONE SESSION ROOT — refused at creation time (card 2026-0293).
//
// `sessionRootPath` keys a local session root as `<project>--<worktree>`, or
// `<project>` for a project root. `--` is legal INSIDE a project name, so a
// project literally called `p--p_worktree_w` computes the same key as worktree
// `w` of project `p`: one directory, one manifest, one CLI cwd, one transcript
// directory. The reachable collider embeds its own prefix twice because the
// stored worktree name is the DIRECTORY name `<project>_worktree_<slug>`, not
// the bare slug.
//
// The refusal is over COMPUTED KEYS, never over parsed `--` splits, and it is
// `encodeCwd`-equality rather than byte-equality — so it also catches the pair
// that lands in one transcript directory without landing in one root.
//
// The fixture keeps the two path spaces disjoint (trees under a temp dir
// outside PROJECTS_ROOT), so nothing here can pass by accident on cc's own disk.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo, git } from './remoteSystem.mjs';
import {
  adoptProject, createProject, encodeCwd, listProjects, projectStoreDir,
} from '../src/projects.ts';
import { createWorktree, registeredWorktreeNames } from '../src/worktrees.ts';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { composeSessionRoot, sessionRootPath } from '../src/systems/sessionRoot.ts';

const exists = async (p) => { try { await fs.lstat(p); return true; } catch { return false; } };

const record = async (name) => {
  try { return JSON.parse(await fs.readFile(path.join(projectStoreDir(name), 'project.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};

// A refusal, whichever shape the surface uses: createProject/createWorktree
// throw an httpError, adoptProject returns `{ok:false, code, reason}`. Both
// reduce to `{status, text}` so one assertion serves either.
async function refusal(fn) {
  try {
    const r = await fn();
    if (r && r.ok === false) return { status: 409, text: `${r.code} ${r.reason}`, soft: r };
    return null;
  } catch (e) {
    return { status: e.statusCode ?? 500, text: String(e.message ?? e), thrown: e };
  }
}

describe('session-root key collisions are refused at creation', () => {
  let home, remote;
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  const onSystem = (rel) => path.join(remote.root, rel);

  // ── T1 ─────────────────────────────────────────────────────────────
  //
  // PINS the createProject guard (§2). A project name whose key is byte-equal
  // to a REGISTERED worktree's key is refused, and nothing is created for it.
  //
  // NOT CLAIMING: that no colliding pair can exist at all — the check is
  // order-dependent by design (T6 is the other order), and it does not close
  // the two-concurrent-creates race.
  test('T1 — createProject on a system refuses a name whose session-root key already belongs to a registered worktree', async () => {
    await seedRepo(onSystem('p'));
    await adoptProject('p', onSystem('p'), { system: remote.id });
    const wt = await createWorktree('p', { name: 'w' });
    assert.equal(wt.worktreeName, 'p_worktree_w');
    assert.equal(
      sessionRootPath(remote.id, 'p', wt.worktreeName),
      sessionRootPath(remote.id, 'p--p_worktree_w', null),
      'the premise: the two keys compute one path',
    );

    const r = await refusal(() => createProject('p--p_worktree_w', {
      system: remote.id, systemPath: onSystem('collider'),
    }));
    assert.ok(r, 'createProject must refuse');
    assert.equal(r.status, 409);
    assert.match(r.text, /p--p_worktree_w/, 'names the candidate');
    assert.match(r.text, /p_worktree_w/, 'names the colliding worktree');
    assert.match(r.text, /'p'/, 'names the colliding worktree\'s project');
    // THE BYTE-EQUAL MESSAGE SHAPE, pinned distinctly from the encode-only one
    // in T4: this pair really does land in ONE session root, so the flat harm
    // sentence is the true one here.
    assert.match(r.text, /its session root would be/);
    assert.match(r.text, /Two places on one session root share a config surface/);
    assert.doesNotMatch(r.text, /collapses/, 'not the encode-only wording');

    assert.equal(await record('p--p_worktree_w'), null, 'no record written for a refused create');
    assert.equal(await exists(onSystem('collider')), false, 'nothing created on the system');
    assert.deepEqual((await listProjects()).map(p => p.name), ['p']);
  });

  // ── T2 ─────────────────────────────────────────────────────────────
  //
  // PINS the adoptProject guard (§3) — the SOFT refusal shape this path owes
  // every other refusal on it, and that it sits before `writeProjectRecord`.
  //
  // NOT CLAIMING: that the adopted tree is otherwise untouched by cc; the
  // assertion here is only that no project RECORD exists afterwards.
  test('T2 — adoptProject refuses SESSION_ROOT_COLLISION and writes no project record', async () => {
    await seedRepo(onSystem('q'));
    await adoptProject('q', onSystem('q'), { system: remote.id });
    await createWorktree('q', { name: 'w' });
    const colliderTree = await seedRepo(onSystem('other'));

    const res = await adoptProject('q--q_worktree_w', colliderTree, { system: remote.id });
    assert.equal(res.ok, false, 'adopt must refuse');
    assert.equal(res.code, 'SESSION_ROOT_COLLISION');
    assert.match(res.reason, /q--q_worktree_w/);
    assert.match(res.reason, /q_worktree_w/);

    assert.equal(await record('q--q_worktree_w'), null, 'a refused adopt writes no record');
    assert.deepEqual((await listProjects()).map(p => p.name), ['q']);
  });

  // ── T3 ─────────────────────────────────────────────────────────────
  //
  // PINS the createWorktree guard (§4) — the REVERSE order, and that it fires
  // before any git state is touched.
  //
  // NOT CLAIMING: anything about worktrees created outside cc (`git worktree
  // add` through a shell carries no registration and therefore no key).
  test('T3 — createWorktree refuses when a project already holds the key its worktree would take', async () => {
    await seedRepo(onSystem('r'));
    await adoptProject('r', onSystem('r'), { system: remote.id });
    await createProject('r--r_worktree_w', { system: remote.id, systemPath: onSystem('collider') });

    const r = await refusal(() => createWorktree('r', { name: 'w' }));
    assert.ok(r, 'createWorktree must refuse');
    assert.equal(r.status, 409);
    assert.match(r.text, /r--r_worktree_w/, 'names the colliding project');

    // No git state touched: no branch, no worktree dir, no registration.
    const branches = await git(onSystem('r'), 'branch', '--list', 'code-conductor/w');
    assert.equal(branches.stdout.trim(), '', 'the refusal fires before the branch pre-check');
    const wtList = await git(onSystem('r'), 'worktree', 'list');
    assert.equal(wtList.stdout.trim().split('\n').length, 1, 'only the main tree');
    assert.equal(await exists(onSystem('r_worktree_w')), false);
    assert.deepEqual(await registeredWorktreeNames('r'), []);
  });

  // ── T4 ─────────────────────────────────────────────────────────────
  //
  // PINS the WIDTH of the predicate: `encodeCwd`-equality, not `===`. Arm (a)
  // is the one that dies if the comparison is narrowed to byte-equality — the
  // two session roots are DIFFERENT directories, but the CLI collapses `_` to
  // `-` when it names a transcript directory, so both sessions' transcripts
  // land in one place.
  //
  // NOT CLAIMING EITHER DIRECTION of "encodeCwd-equal keys IFF one transcript
  // directory". Both fail, because the CLI's cwd is `realpath(root) +
  // mirror.offset` and the offset is the PROVIDER's:
  //   • WIDER — two places whose keys encode alike but whose providers
  //     advertise different mirror geometries do not in fact collide, so this
  //     refuses a pair that would have been fine (card 2026-0293 §G-4).
  //   • NARROWER — the offset supplies characters the key comparison never
  //     sees, so a pair whose KEYS differ can still land in one transcript
  //     directory (project `p` at offset `-q` versus project `p--q`). That is
  //     NOT refused, here or anywhere; card 2026-0304 owns it.
  // The predicate is a proxy keyed on cc's own stable geometry, deliberately,
  // and neither this test nor any other claims it is sufficient.
  test('T4 — a key that only ENCODES alike is refused too', async () => {
    // (a) project `a--a-worktree-b` versus worktree `b` of project `a`.
    await seedRepo(onSystem('a'));
    await adoptProject('a', onSystem('a'), { system: remote.id });
    const wt = await createWorktree('a', { name: 'b' });
    assert.equal(wt.worktreeName, 'a_worktree_b');
    const takenRoot = sessionRootPath(remote.id, 'a', wt.worktreeName);
    const candRoot = sessionRootPath(remote.id, 'a--a-worktree-b', null);
    assert.notEqual(takenRoot, candRoot, 'the premise: byte-equality would NOT catch this pair');
    assert.equal(encodeCwd(takenRoot), encodeCwd(candRoot), 'the premise: they encode alike');

    const ra = await refusal(() => createProject('a--a-worktree-b', {
      system: remote.id, systemPath: onSystem('collider-a'),
    }));
    assert.ok(ra, 'an encode-only collision must refuse');
    assert.equal(ra.status, 409);
    // THE ENCODE-ONLY MESSAGE SHAPE. `sameRoot` is the discriminator, so both
    // arms of it are pinned: this pair does NOT share a session root, and
    // saying it did would be the overclaim. Also pins the possessive rewrite —
    // `${held}'s` rendered `…project 'a''s`.
    assert.match(ra.text, /collapses when it names a transcript directory/);
    assert.match(ra.text, /the one worktree 'a_worktree_b' of project 'a' already holds/);
    assert.match(ra.text, /The two roots stay separate/);
    assert.doesNotMatch(ra.text, /Two places on one session root share/,
      'the byte-equal harm is false here — the roots differ');
    assert.doesNotMatch(ra.text, /''/, 'no double-apostrophe possessive');

    // (b) remote `my_app` versus remote `my-app` on the same system.
    await createProject('my_app', { system: remote.id, systemPath: onSystem('my_app') });
    const rb = await refusal(() => createProject('my-app', {
      system: remote.id, systemPath: onSystem('my-app'),
    }));
    assert.ok(rb, 'two remote projects that encode alike must refuse');
    assert.equal(rb.status, 409);
    assert.match(rb.text, /my_app/);
    assert.equal(await exists(onSystem('my-app')), false);
  });

  // ── T9 ─────────────────────────────────────────────────────────────
  //
  // PINS THE CANDIDATE-IDENTITY EXCLUSION. Re-creating a worktree that is
  // already registered is a DUPLICATE-CREATE, not a cross-place collision, and
  // it must keep reaching the branch pre-check — whose diagnostic names the two
  // states a user can actually be in ("still registered" / "deleted and left
  // the branch behind"), where the collision guard would only say "pick another
  // name".
  //
  // NOT CLAIMING that the branch pre-check is correct, or that it covers the
  // deleted-but-branch-left case; this asserts only WHICH refusal answers, by
  // its message and by the absence of the collision guard's `code`.
  test('T9 — re-creating a still-registered worktree is a DUPLICATE, not a session-root collision', async () => {
    await seedRepo(onSystem('dup'));
    await adoptProject('dup', onSystem('dup'), { system: remote.id });
    await createWorktree('dup', { name: 'w' });

    const r = await refusal(() => createWorktree('dup', { name: 'w' }));
    assert.ok(r, 'a duplicate worktree is still refused');
    assert.equal(r.status, 409);
    assert.equal(r.thrown.code, undefined, 'not the collision guard');
    assert.match(r.text, /branch 'code-conductor\/w' already exists in project 'dup'/);
    assert.match(r.text, /still registered/, 'the diagnostic the branch check owns');
    assert.doesNotMatch(r.text, /session root/);
  });

  // ── T5 (CONTROL) ───────────────────────────────────────────────────
  //
  // PINS that the guard changes NOTHING for a non-colliding pair: the ordinary
  // project and the ordinary worktree still compose to the paths they compose
  // to today, with the same manifests and the same pulled bytes.
  //
  // GREEN ON ARRIVAL by construction — it pins the absence of a regression, and
  // proves nothing about the guard itself.
  test('T5 — CONTROL: an ordinary project and an ordinary worktree compose to the paths they compose to today, byte-identically', async () => {
    const tree = await seedRepo(onSystem('demo'));
    await fs.writeFile(path.join(tree, 'CLAUDE.md'), '@CONVENTIONS.md\nproject notes\n');
    await adoptProject('demo', tree, { system: remote.id });
    // Adoption writes CLAUDE.md + CONVENTIONS.md into the tree UNTRACKED, so a
    // worktree checked out off HEAD would carry neither and compose an empty
    // root. Committing them is what makes the worktree's root a real one.
    await git(tree, 'add', '-A');
    await git(tree, 'commit', '-q', '-m', 'conventions');
    const wt = await createWorktree('demo', { name: 'feature' });
    assert.equal(wt.worktreeName, 'demo_worktree_feature');

    const system = await systemById(remote.id, null, 'test');
    const rootComposed = await composeSessionRoot({
      system, systemId: remote.id, systemPath: tree, project: 'demo', worktree: null,
    });
    const wtComposed = await composeSessionRoot({
      system, systemId: remote.id, systemPath: wt.worktreePath, project: 'demo', worktree: wt.worktreeName,
    });

    // The paths, resolved independently of the composer.
    assert.equal(rootComposed.root, sessionRootPath(remote.id, 'demo', null));
    assert.equal(wtComposed.root, sessionRootPath(remote.id, 'demo', 'demo_worktree_feature'));
    assert.equal(path.basename(rootComposed.root), 'demo');
    assert.equal(path.basename(wtComposed.root), 'demo--demo_worktree_feature');
    assert.notEqual(rootComposed.root, wtComposed.root, 'two roots, not one');

    // Two manifests, each beside its own root, each naming its own target.
    for (const r of [rootComposed, wtComposed]) {
      const m = JSON.parse(await fs.readFile(`${r.root}.manifest.json`, 'utf8'));
      assert.equal(m.remoteId ?? null, null);
      assert.ok(Object.keys(m.entries ?? {}).length > 0, 'the manifest lists what was pulled');
      assert.ok('CLAUDE.md' in m.entries, 'including the config surface the CLI reads implicitly');
    }
    assert.notEqual(
      await fs.realpath(`${rootComposed.root}.manifest.json`),
      await fs.realpath(`${wtComposed.root}.manifest.json`),
    );

    // The pulled bytes are the system's, in both roots.
    assert.equal(
      await fs.readFile(path.join(rootComposed.root, 'CLAUDE.md'), 'utf8'),
      await fs.readFile(path.join(tree, 'CLAUDE.md'), 'utf8'),
    );
    assert.equal(
      await fs.readFile(path.join(wtComposed.root, 'CLAUDE.md'), 'utf8'),
      await fs.readFile(path.join(wt.worktreePath, 'CLAUDE.md'), 'utf8'),
    );
  });

  // ── T6 ─────────────────────────────────────────────────────────────
  //
  // PINS that the pair is refused whichever half arrives second — the two
  // guards are genuinely two, not one read twice.
  //
  // NOT CLAIMING order-INDEPENDENCE of the outcome in any stronger sense: the
  // FIRST half always succeeds, and which half that is decides which name the
  // refusal names.
  test('T6 — the guard is order-independent: the pair is refused whichever half is created second', async () => {
    // Order A — worktree first, project second.
    await seedRepo(onSystem('s'));
    await adoptProject('s', onSystem('s'), { system: remote.id });
    await createWorktree('s', { name: 'w' });
    const a = await refusal(() => createProject('s--s_worktree_w', {
      system: remote.id, systemPath: onSystem('collider-s'),
    }));
    assert.ok(a, 'order A must refuse');
    assert.match(a.text, /s_worktree_w/, 'order A names the worktree');

    // Order B — project first, worktree second.
    await seedRepo(onSystem('t'));
    await adoptProject('t', onSystem('t'), { system: remote.id });
    await createProject('t--t_worktree_w', { system: remote.id, systemPath: onSystem('collider-t') });
    const b = await refusal(() => createWorktree('t', { name: 'w' }));
    assert.ok(b, 'order B must refuse');
    assert.match(b.text, /t--t_worktree_w/, 'order B names the project');
  });

  // ── T7 (CONTROL) ───────────────────────────────────────────────────
  //
  // PINS THE SCOPE BOUNDARY. A local place has no session root, so the guard
  // must not run for one — including for the `my_app` / `my-app` pair, which
  // DOES share a transcript directory today and is deliberately left unfixed
  // (card 2026-0293 §G-3; the local half is card 2026-0303).
  //
  // GREEN ON ARRIVAL by construction. Its job is to make a future widening of
  // the guard to local places fail loudly rather than pass unnoticed.
  test('T7 — CONTROL: the guard does not run for local places', async () => {
    const a = await createProject('my_app');
    const b = await createProject('my-app');
    assert.notEqual(a.path, b.path, 'two local directories');
    assert.equal(encodeCwd(a.path), encodeCwd(b.path), 'that DO share one transcript directory — unfixed');

    // A local project and a local project named after its own worktree dir:
    // byte-equal keys if keys existed, and still allowed, because they do not.
    const u = await createProject('u');
    await git(u.path, 'config', 'user.email', 'test@example.com');
    await git(u.path, 'config', 'user.name', 'Test');
    await git(u.path, 'add', '-A');
    await git(u.path, 'commit', '-q', '-m', 'initial');
    await createProject('u--u_worktree_w');
    const wt = await createWorktree('u', { name: 'w' });
    assert.equal(wt.worktreeName, 'u_worktree_w');
    assert.deepEqual(
      (await listProjects()).map(p => p.name).sort(),
      ['my-app', 'my_app', 'u', 'u--u_worktree_w'],
    );
  });
});

// ── T8 ───────────────────────────────────────────────────────────────
//
// PINS THE FUNNEL BY REACHING IT (card 2026-0293 §G-8). `createWorktree` has
// exactly two callers — the MCP `create_worktree` tool (T1-T6 reach that shape
// directly) and spawn-with-worktree at src/instances.ts. This drives the SECOND
// one over the real MCP surface, so "one guard covers both" is measured rather
// than read off the call graph.
//
// It has to be MCP, not `POST /api/instances`: the REST route destructures no
// `name` (src/routes.ts), so a REST spawn always gets a random slug and can
// never name the colliding half. `spawn_instance` carries `name` through to
// createWorktree, which is what makes the pair constructible here at all.
//
// NOT CLAIMING anything about the session itself: the refusal fires before any
// instance exists, so nothing downstream of the worktree create is exercised.
describe('spawn-with-worktree reaches the same guard', () => {
  let ctx, baseUrl, home, remote;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
  });
  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  test('T8 — spawn_instance with createWorktree:true is refused by the same collision guard', async () => {
    const tree = await seedRepo(path.join(remote.root, 'v'));
    await adoptProject('v', tree, { system: remote.id });
    await createProject('v--v_worktree_w', {
      system: remote.id, systemPath: path.join(remote.root, 'collider-v'),
    });

    const before = ctx.instances.list().length;
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'spawn_instance',
          arguments: { project: 'v', mode: 'bypassPermissions', createWorktree: true, name: 'w' },
        },
      }),
    });
    const body = await res.json();
    const rendered = JSON.stringify(body);
    // isError, not merely "the text mentions the name": on the shipped code the
    // spawn SUCCEEDS and its own cwd is `…/sessions/v--v_worktree_w`, so a bare
    // name match passes in both states and proves nothing.
    assert.equal(body.result?.isError, true, `the spawn was not refused: ${rendered}`);
    assert.match(rendered, /v--v_worktree_w/, 'the refusal names the colliding project');
    assert.equal(ctx.instances.list().length, before, 'no instance was created');
    assert.deepEqual(await registeredWorktreeNames('v'), [], 'no worktree was registered');
  });
});
