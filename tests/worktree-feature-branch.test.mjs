// Feature branches: a worktree based on another worktree.
//
// A worktree that others are based on is a "feature"; a worktree with a
// baseWorktree is a "task". Both derived from one stored field. These tests pin
// the three things that make the arrangement work and that nothing else covers:
//   - a feature's own history survives its sync (--rebase-merges, both call
//     sites) — T1, T2, T10
//   - a task rebases onto its FEATURE, not onto the project's branch — T12
//   - WORKTREE_HAS_DEPENDENTS gates sync/merge/delete over worktree RECORDS, is
//     unconditional on ahead/behind, precedes WORKTREE_BEHIND, and applies to
//     the worktree being synced/merged and never to the merge TARGET — T3-T5, T12
//   - the delete gate holds on all three surfaces (service layer, MCP soft
//     channel, REST), leaves dir + record + branch intact, is cleared by
//     deleting the children, and is overridden by force — T14-T18
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { api, bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  createWorktree, getWorktree, listWorktrees, listDependentWorktrees,
  syncWorktree, mergeWorktreeIntoParent, removeWorktree, buildRebasePrompt,
} from '../src/worktrees.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// Manual wrap of execFile — promisify(execFile) on this Node build
// resolves to just stdout (a string) instead of {stdout, stderr}.
function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

// Exit code only — for predicates like `merge-base --is-ancestor`.
function gitCode(cwd, ...args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err) => {
      resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0);
    });
  });
}

async function makeRealRepo(name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test repo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

// A linked worktree shares the main repo's config, but set the identity anyway
// so a commit here can't depend on host-level git config.
async function configureIdentity(wtPath) {
  await git(wtPath, 'config', 'user.email', 'agent@example.com');
  await git(wtPath, 'config', 'user.name', 'agent');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');
}

async function commitFile(cwd, filename, content, message) {
  await fs.writeFile(path.join(cwd, filename), content);
  await configureIdentity(cwd);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-q', '-m', message);
  return (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim();
}

const headSha = async (cwd) => (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim();
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
// Is `branch` still a ref in the repo? The branch is the third thing a delete
// destroys (after the dir and the store entry) and the one that actually breaks
// the children, so the refusal tests assert it separately.
const branchExists = async (repoPath, branch) =>
  (await gitCode(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) === 0;

// Count merge commits (>=2 parents) on `branch` that are not on `notOn`.
async function mergeCommitCount(cwd, branch, notOn) {
  const args = ['rev-list', '--min-parents=2', '--count', branch];
  if (notOn) args.push(`^${notOn}`);
  return Number.parseInt((await git(cwd, ...args)).stdout.trim(), 10);
}

// --- MCP helpers (mirroring tests/mcp.test.mjs) ---
let nextRpcId = 1;
async function rpc(method, params) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function callTool(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
const unwrap = (result) => JSON.parse(result.content[0].text);
const textOf = (result) => result.content[0].text;

// A feature worktree plus N task worktrees based on it.
async function makeFeature(project, { name = 'auth', tasks = 0 } = {}) {
  const repoPath = await makeRealRepo(project);
  const feature = await createWorktree(project, { name });
  const taskMetas = [];
  for (let i = 0; i < tasks; i++) {
    taskMetas.push(await createWorktree(project, { baseWorktree: feature.worktreeName }));
  }
  return { repoPath, feature, tasks: taskMetas };
}

// ---------------------------------------------------------------------------
// T1 — a feature's merge commits survive its own sync (--rebase-merges at the
//      automated call site, src/worktrees.ts syncWorktree).
// ---------------------------------------------------------------------------
test('T1: syncing a feature preserves the task merge commit it carries', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { name: 'auth', tasks: 1 });
  const task = tasks[0];

  await commitFile(task.worktreePath, 'task.js', 'export const task = 1;\n', 'task work');
  const merged = await mergeWorktreeIntoParent('demo', task.worktreeName);
  assert.equal(merged.ok, true, `merge into feature failed: ${JSON.stringify(merged)}`);
  // The feature now carries a real merge commit.
  assert.equal(await mergeCommitCount(feature.worktreePath, feature.branch, 'main'), 1);

  // Drop the task so the feature has no dependents and may sync.
  await removeWorktree('demo', task.worktreeName);
  await commitFile(repoPath, 'main.js', 'export const m = 1;\n', 'main moves on');

  const synced = await syncWorktree('demo', feature.worktreeName);
  assert.equal(synced.ok, true, `sync failed: ${JSON.stringify(synced)}`);
  assert.equal(synced.action, 'rebased');

  // THE invariant: the task's merge commit is still a 2-parent commit above the
  // new base. A bare `git rebase` flattens it to 0 while still reporting
  // 'rebased', so asserting the action alone would prove nothing here.
  assert.equal(
    await mergeCommitCount(feature.worktreePath, feature.branch, 'main'), 1,
    'the task merge commit was flattened by the rebase (is --rebase-merges still there?)',
  );
  // ...and the side branch's content came along with it.
  assert.equal(await exists(path.join(feature.worktreePath, 'task.js')), true);
  assert.equal(await exists(path.join(feature.worktreePath, 'main.js')), true);
});

// ---------------------------------------------------------------------------
// T2 — the conflict path instructs the same history-preserving rebase.
// ---------------------------------------------------------------------------
test('T2: buildRebasePrompt tells the agent to rebase with --rebase-merges', async () => {
  await makeRealRepo('demo');
  const feature = await createWorktree('demo', { name: 'auth' });
  const prompt = buildRebasePrompt(feature);
  // T1 cannot see this string — it exercises the server-side rebase only — so a
  // flag on just one of the two call sites would let the agent-driven conflict
  // path flatten exactly what the automated path preserved. This is not the only
  // catcher: two rebase-prompt assertions in tests/worktrees.test.mjs match the
  // command text too. This one states the invariant directly.
  assert.match(prompt, /git rebase --rebase-merges main/);
});

// ---------------------------------------------------------------------------
// T3 — sync refuses over RECORDS and mutates nothing.
// ---------------------------------------------------------------------------
test('T3: sync refuses WORKTREE_HAS_DEPENDENTS, names every dependent, changes nothing', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { tasks: 2 });
  await commitFile(repoPath, 'main.js', 'export const m = 1;\n', 'main moves on');

  const before = await headSha(feature.worktreePath);
  const r = await syncWorktree('demo', feature.worktreeName);

  assert.equal(r.ok, false);
  assert.equal(r.code, 'WORKTREE_HAS_DEPENDENTS');
  // No instance exists anywhere in this test — the predicate is over records.
  for (const t of tasks) {
    assert.ok(r.dependents.includes(t.worktreeName), `dependents missing ${t.worktreeName}`);
    assert.ok(r.reason.includes(t.worktreeName), `reason does not name ${t.worktreeName}`);
  }
  assert.equal(r.dependents.length, 2);
  // Refused before any git mutation: the branch is byte-identical.
  assert.equal(await headSha(feature.worktreePath), before);
});

// ---------------------------------------------------------------------------
// T4 — the refusal does not depend on the base having moved.
// ---------------------------------------------------------------------------
test('T4: sync refuses with dependents even when the feature is not behind', async () => {
  const { feature } = await makeFeature('demo', { tasks: 1 });
  // `main` has NOT moved, so without the gate this returns already-in-sync and
  // the caller never learns the constraint.
  const r = await syncWorktree('demo', feature.worktreeName);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WORKTREE_HAS_DEPENDENTS');
});

// ---------------------------------------------------------------------------
// T5 — merge gate order: dependents before WORKTREE_BEHIND, and before a merge
//      that would otherwise succeed.
// ---------------------------------------------------------------------------
test('T5a: merge reports HAS_DEPENDENTS rather than the WORKTREE_BEHIND it also is', async () => {
  const { repoPath, feature } = await makeFeature('demo', { tasks: 1 });
  await commitFile(repoPath, 'main.js', 'export const m = 1;\n', 'main moves on');

  const r = await mergeWorktreeIntoParent('demo', feature.worktreeName);
  assert.equal(r.ok, false);
  // Both conditions hold. Behind-first would send the caller to sync_worktree,
  // which refuses for the real reason — so the gate order is what makes the
  // blocker legible on the first call.
  assert.equal(r.code, 'WORKTREE_HAS_DEPENDENTS');
});

test('T5b: merge refuses with dependents even when it would otherwise succeed', async () => {
  const { repoPath, feature } = await makeFeature('demo', { tasks: 1 });
  // Feature ahead, base not moved: without the gate this is a real merge.
  await commitFile(feature.worktreePath, 'feature.js', 'export const f = 1;\n', 'feature work');
  const mainBefore = await headSha(repoPath);

  const r = await mergeWorktreeIntoParent('demo', feature.worktreeName);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WORKTREE_HAS_DEPENDENTS');
  assert.equal(await headSha(repoPath), mainBefore, 'the refused merge still moved the base');
});

// ---------------------------------------------------------------------------
// T6 — depth cap.
// ---------------------------------------------------------------------------
test('T6: a worktree based on a derived worktree is refused, leaving nothing behind', async () => {
  const { feature, tasks } = await makeFeature('demo', { tasks: 1 });
  const countBefore = (await listWorktrees('demo')).length;

  await assert.rejects(
    () => createWorktree('demo', { baseWorktree: tasks[0].worktreeName }),
    (e) => {
      assert.equal(e.statusCode, 400);
      assert.match(e.message, /is itself based on/);
      assert.ok(e.message.includes(feature.worktreeName), 'message should name the base of the base');
      return true;
    },
  );
  // Refused before `git worktree add`, so no partial worktree is registered.
  assert.equal((await listWorktrees('demo')).length, countBefore);
});

// ---------------------------------------------------------------------------
// T7 — named worktrees.
// ---------------------------------------------------------------------------
test('T7: a name is slugified into the branch + dir; collisions and empty slugs refuse', async () => {
  await makeRealRepo('demo');

  const wt = await createWorktree('demo', { name: 'Auth Refactor!' });
  assert.equal(wt.worktreeName, 'demo_worktree_auth-refactor');
  assert.equal(wt.branch, 'code-conductor/auth-refactor');
  assert.equal(await exists(wt.worktreePath), true);

  await assert.rejects(
    () => createWorktree('demo', { name: '!!!' }),
    (e) => { assert.equal(e.statusCode, 400); return true; },
  );

  await createWorktree('demo', { name: 'auth' });
  const countBefore = (await listWorktrees('demo')).length;
  await assert.rejects(
    () => createWorktree('demo', { name: 'auth' }),
    (e) => { assert.equal(e.statusCode, 409); return true; },
  );
  // The pre-check turns what would be git's 500 into a clean 409, and no second
  // record appears under the taken name.
  assert.equal((await listWorktrees('demo')).length, countBefore);

  // The unnamed path is unchanged: still a random short id.
  const anon = await createWorktree('demo');
  assert.match(anon.worktreeName, /^demo_worktree_[0-9a-f]{6}$/);
  assert.equal(anon.baseWorktree, undefined, 'a root-based record carries no baseWorktree');
});

// ---------------------------------------------------------------------------
// T13 — the collision check is on the branch ref, so it also catches the state
//       a directory check cannot see: a leftover branch with no worktree.
// ---------------------------------------------------------------------------
test('T13: a slug whose branch survived a deleted worktree refuses 409', async () => {
  const repoPath = await makeRealRepo('demo');
  const wt = await createWorktree('demo', { name: 'auth' });
  // An unmerged commit makes removeWorktree's best-effort `git branch -d` fail,
  // which is exactly how this state arises in practice: the worktree and its
  // record go, the branch stays.
  await commitFile(wt.worktreePath, 'wip.js', 'export const wip = 1;\n', 'unmerged work');
  await removeWorktree('demo', wt.worktreeName);

  // Premise, asserted rather than assumed: branch present, record and dir gone.
  assert.equal(
    await gitCode(repoPath, 'rev-parse', '--verify', '--quiet', 'refs/heads/code-conductor/auth'), 0,
    'precondition: the branch should have survived the delete',
  );
  assert.equal(await exists(wt.worktreePath), false);
  const countBefore = (await listWorktrees('demo')).length;
  assert.equal(countBefore, 0, 'precondition: no worktree record remains');

  await assert.rejects(
    () => createWorktree('demo', { name: 'auth' }),
    (e) => { assert.equal(e.statusCode, 409); return true; },
  );
  assert.equal((await listWorktrees('demo')).length, countBefore);
  assert.equal(await exists(wt.worktreePath), false, 'the refused create made no directory');
});

// ---------------------------------------------------------------------------
// T8 — base resolution goes through the store, and parentProject stays root.
// ---------------------------------------------------------------------------
test('T8: baseWorktree resolves via store records; parentProject stays the root project', async () => {
  await makeRealRepo('demo');
  await makeRealRepo('other');
  const feature = await createWorktree('demo', { name: 'auth' });
  const otherWt = await createWorktree('other');

  await assert.rejects(
    () => createWorktree('demo', { baseWorktree: 'nope' }),
    (e) => { assert.equal(e.statusCode, 404); return true; },
  );
  // Project-scoped: another project's worktree is not a legal base.
  await assert.rejects(
    () => createWorktree('demo', { baseWorktree: otherWt.worktreeName }),
    (e) => { assert.equal(e.statusCode, 404); return true; },
  );

  const featureHead = await headSha(feature.worktreePath);
  const task = await createWorktree('demo', { baseWorktree: feature.worktreeName });
  assert.equal(task.baseWorktree, feature.worktreeName);
  assert.equal(task.parentPath, feature.worktreePath);
  assert.equal(task.baseBranch, feature.branch);
  assert.equal(task.baseSha, featureHead);
  // Load-bearing: listWorktrees filters on parentProject, so recording the
  // base's name here would hide the worktree from every listing in the app.
  assert.equal(task.parentProject, 'demo');
  assert.ok((await listWorktrees('demo')).some(w => w.worktreeName === task.worktreeName));
  assert.deepEqual(await listDependentWorktrees('demo', feature.worktreeName), [task.worktreeName]);

  // The record round-trips through disk with the field intact.
  const reread = await getWorktree('demo', task.worktreeName);
  assert.equal(reread.baseWorktree, feature.worktreeName);
});

// ---------------------------------------------------------------------------
// T9 — MCP surface: schemas accept the args, refusals travel the soft channel.
// ---------------------------------------------------------------------------
test('T9: MCP create_worktree takes name/baseWorktree; refusals keep their channel', async () => {
  await makeRealRepo('demo');

  // Unknown properties are rejected by the router, so this also proves the
  // schema gained both keys.
  const feature = unwrap(await callTool('create_worktree', { project: 'demo', name: 'auth' }));
  assert.equal(feature.worktree, 'demo_worktree_auth');
  assert.equal(feature.branch, 'code-conductor/auth');

  const task = unwrap(await callTool('create_worktree', {
    project: 'demo', baseWorktree: 'demo_worktree_auth',
  }));
  assert.equal(task.baseWorktree, 'demo_worktree_auth');
  assert.equal(task.baseBranch, 'code-conductor/auth');

  // Depth cap surfaces as an error (prose + BAD_REQUEST), like every other
  // create_worktree refusal.
  const capped = await callTool('create_worktree', { project: 'demo', baseWorktree: task.worktree });
  assert.equal(capped.isError, true);
  assert.equal(JSON.parse(capped.content[1].text).code, 'BAD_REQUEST');

  // A business refusal is soft: no isError, and the reason reaches the caller
  // un-reworded — proving it is minted once in the git layer, not per surface.
  const refused = await callTool('merge_worktree', { project: 'demo', worktree: 'demo_worktree_auth' });
  assert.ok(!refused.isError, 'a dependents refusal must not use the error channel');
  const body = unwrap(refused);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'WORKTREE_HAS_DEPENDENTS');
  assert.deepEqual(body.dependents, [task.worktree]);
  assert.ok(body.reason.includes(task.worktree));
});

// ---------------------------------------------------------------------------
// T11 — list_worktrees never labels a row with another row's parent.
// ---------------------------------------------------------------------------
test('T11: list_worktrees header carries no parentPath, and marks a derived row', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { tasks: 1 });
  const text = textOf(await callTool('list_worktrees', { project: 'demo' }));
  const header = text.split('\n')[0];

  assert.match(header, /^WORKTREES \(/);
  assert.ok(header.includes('demo'), 'header still names the parent project');
  // The rows no longer share a parentPath — the first row's must not be hoisted
  // into the header as though they did.
  assert.ok(!header.includes(repoPath), `header hoisted a row's parentPath: ${header}`);

  const featureRow = text.split('\n').find(l => l.startsWith(feature.worktreeName));
  const taskRow = text.split('\n').find(l => l.startsWith(tasks[0].worktreeName));
  assert.ok(featureRow.includes('base main@'), featureRow);
  assert.ok(taskRow.includes(`base ${feature.branch}@`), taskRow);
  assert.ok(taskRow.includes(`← ${feature.worktreeName}`), taskRow);
});

// ---------------------------------------------------------------------------
// T10 — acceptance: the two-level history shape on the project's branch.
// ---------------------------------------------------------------------------
test('T10: a landed feature yields main <- merge(feature) <- merge(task)', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { name: 'auth', tasks: 1 });
  const task = tasks[0];

  await commitFile(task.worktreePath, 'task.js', 'export const task = 1;\n', 'task work');
  assert.equal((await mergeWorktreeIntoParent('demo', task.worktreeName)).ok, true);
  await removeWorktree('demo', task.worktreeName);
  await commitFile(repoPath, 'main.js', 'export const m = 1;\n', 'main moves on');
  assert.equal((await syncWorktree('demo', feature.worktreeName)).action, 'rebased');

  const landed = await mergeWorktreeIntoParent('demo', feature.worktreeName);
  assert.equal(landed.ok, true, `landing the feature failed: ${JSON.stringify(landed)}`);

  // Two merge commits on main: the feature's landing merge, and the task's merge
  // nested inside it. A flattening rebase leaves only the first.
  assert.equal(
    await mergeCommitCount(repoPath, 'main'), 2,
    'expected the task merge to survive nested inside the feature merge',
  );
  const firstParent = (await git(repoPath, 'log', '--first-parent', '--format=%s', '-1', 'main')).stdout.trim();
  assert.match(firstParent, /^Merge branch 'code-conductor\/auth'/);
  assert.equal(await exists(path.join(repoPath, 'task.js')), true);
});

// ---------------------------------------------------------------------------
// T14 — the delete gate in the shared git layer, and its ordering: nothing is
//       removed before it fires.
// ---------------------------------------------------------------------------
test('T14: removeWorktree refuses 409 for a base, leaving dir + record + branch intact', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { name: 'auth', tasks: 1 });
  const task = tasks[0];

  await assert.rejects(
    () => removeWorktree('demo', feature.worktreeName),
    (e) => {
      assert.equal(e.statusCode, 409);
      assert.match(e.message, /is the base for/);
      assert.ok(e.message.includes(task.worktreeName), `message does not name ${task.worktreeName}`);
      return true;
    },
  );

  // THE invariant: the guard precedes every removal removeWorktree performs, so
  // a refused delete is a no-op on all three. Without the check the call above
  // resolves and this test fails at assert.rejects; with the check placed after
  // `git worktree remove` / `git branch -d` it fails here instead. It cannot
  // pass either way.
  assert.equal(await exists(feature.worktreePath), true, 'the refused delete removed the directory');
  assert.ok(await getWorktree('demo', feature.worktreeName), 'the refused delete dropped the store record');
  assert.equal(
    await branchExists(repoPath, feature.branch), true,
    'the refused delete deleted the branch the child is based on',
  );
  assert.equal((await listWorktrees('demo')).length, 2);
});

// ---------------------------------------------------------------------------
// T15 — the MCP half of the same gate: a business refusal, not a fault.
// ---------------------------------------------------------------------------
test('T15: MCP delete_worktree refuses on the soft channel with dependents[]', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { name: 'auth', tasks: 1 });
  const task = tasks[0];

  const refused = await callTool('delete_worktree', { project: 'demo', worktree: feature.worktreeName });
  // Without the handler's pre-check this still refuses — but as removeWorktree's
  // 409 travelling the ERROR channel, with no ok/code/dependents for the caller
  // to branch on. That is what these four assertions separate.
  assert.ok(!refused.isError, 'a dependents refusal must not use the error channel');
  const body = unwrap(refused);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'WORKTREE_HAS_DEPENDENTS');
  assert.deepEqual(body.dependents, [task.worktreeName]);
  assert.ok(body.reason.includes(task.worktreeName), 'reason does not name the dependent');

  assert.ok(await getWorktree('demo', feature.worktreeName));
  assert.equal(await branchExists(repoPath, feature.branch), true);
});

// ---------------------------------------------------------------------------
// T16 — force overrides the gate, and orphaning is the documented consequence.
// ---------------------------------------------------------------------------
test('T16: delete_worktree force:true deletes the base and orphans its child', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { name: 'auth', tasks: 1 });
  const task = tasks[0];

  const done = unwrap(await callTool('delete_worktree', {
    project: 'demo', worktree: feature.worktreeName, force: true,
  }));
  assert.equal(done.ok, undefined, 'success is bare data, no ok');
  assert.equal(done.worktree, feature.worktreeName);
  assert.equal(await getWorktree('demo', feature.worktreeName), null);
  assert.equal(await exists(feature.worktreePath), false);

  // The documented cost of forcing, asserted rather than only written down: the
  // child survives still pointing at a base branch that is now gone.
  assert.equal(await branchExists(repoPath, feature.branch), false);
  const orphan = await getWorktree('demo', task.worktreeName);
  assert.equal(orphan.baseWorktree, feature.worktreeName);
  assert.equal(orphan.baseBranch, feature.branch);
});

// ---------------------------------------------------------------------------
// T17 — the path the refusal steers callers toward, and the direction of the
//       predicate.
// ---------------------------------------------------------------------------
test('T17: deleting the child is unaffected, and child-then-feature needs no force', async () => {
  const { feature, tasks } = await makeFeature('demo', { name: 'auth', tasks: 1 });
  const task = tasks[0];

  // The predicate is "worktrees based on THIS one", not "this one has a base" —
  // an inverted implementation passes T14 and fails right here.
  await removeWorktree('demo', task.worktreeName);
  assert.equal(await getWorktree('demo', task.worktreeName), null);

  // And the refusal is transient: it clears with the last dependent record, so
  // the normal serialized flow lands without ever reaching for force. An
  // implementation keyed on a flag stamped at creation passes the line above and
  // fails this one.
  await removeWorktree('demo', feature.worktreeName);
  assert.equal(await getWorktree('demo', feature.worktreeName), null);
  assert.equal(await exists(feature.worktreePath), false);
  assert.equal((await listWorktrees('demo')).length, 0);
});

// ---------------------------------------------------------------------------
// T18 — the REST/GUI surface, which reaches removeWorktree directly.
// ---------------------------------------------------------------------------
test('T18: REST DELETE refuses 409 naming the child; ?force=1 clears it', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { name: 'auth', tasks: 1 });
  const task = tasks[0];
  const url = `/api/projects/demo/worktrees/${encodeURIComponent(feature.worktreeName)}`;

  // The sidebar's × drives this endpoint and shows body.error in its "Force
  // remove anyway?" confirm — so this surface, not the MCP one, is where an
  // unguarded delete would silently orphan children. A handler-only guard fails
  // here with a 200.
  const refused = await api(baseUrl, 'DELETE', url);
  assert.equal(refused.status, 409);
  assert.ok(refused.body.error.includes(task.worktreeName), `error does not name the child: ${refused.body.error}`);
  assert.ok(await getWorktree('demo', feature.worktreeName));
  assert.equal(await branchExists(repoPath, feature.branch), true);

  const forced = await api(baseUrl, 'DELETE', `${url}?force=1`);
  assert.equal(forced.status, 200);
  assert.equal(await getWorktree('demo', feature.worktreeName), null);
});

// ---------------------------------------------------------------------------
// T12 — the child side of the concurrent discipline: a task rebases onto its
//       feature, not onto the project's branch.
// ---------------------------------------------------------------------------
test('T12: a task rebases onto its feature, not onto main', async () => {
  const { repoPath, feature, tasks } = await makeFeature('demo', { name: 'auth', tasks: 2 });
  const [a, b] = tasks;

  await commitFile(a.worktreePath, 'a.js', 'export const a = 1;\n', 'task A work');
  // B has its own commit, so its sync is genuinely diverged and takes the rebase
  // path rather than the fast-forward.
  await commitFile(b.worktreePath, 'b.js', 'export const b = 1;\n', 'task B work');
  await commitFile(repoPath, 'main.js', 'export const m = 1;\n', 'main moves on');

  // (1) Merging A into the feature succeeds WHILE the feature still has B based
  //     on it. WORKTREE_HAS_DEPENDENTS is about the worktree being merged, never
  //     the merge target — applied to the target, no feature with two children
  //     could ever take a merge and the concurrent discipline would deadlock.
  //     A target-scoped check also breaks T1/T10, which merge a lone task into
  //     its feature; what is unique here is isolating the SCOPE distinction —
  //     this is the only test with a second, non-merging dependent, so it is the
  //     only one that fails for the right reason rather than incidentally.
  const mergedA = await mergeWorktreeIntoParent('demo', a.worktreeName);
  assert.equal(mergedA.ok, true, `merging A into the feature failed: ${JSON.stringify(mergedA)}`);
  assert.deepEqual(await listDependentWorktrees('demo', feature.worktreeName), [a.worktreeName, b.worktreeName]);

  // (2) B syncs against the FEATURE, which has moved; main has moved too, and
  //     the feature has NOT taken it (its own sync is refused while B exists),
  //     so the two are distinguishable by content.
  const synced = await syncWorktree('demo', b.worktreeName);
  assert.equal(synced.ok, true, `syncing B failed: ${JSON.stringify(synced)}`);
  assert.equal(synced.action, 'rebased');

  // (3) The two-sided content check is the point. If baseBranch resolution ever
  //     fell back to the project root's HEAD, B would come up WITH main.js and
  //     WITHOUT a.js — so this fails on both halves rather than merely not
  //     passing. Asserting 'rebased' alone would survive that mutation.
  assert.equal(await exists(path.join(b.worktreePath, 'a.js')), true,
    'B did not pick up its feature\'s content — did it rebase onto main instead?');
  assert.equal(await exists(path.join(b.worktreePath, 'main.js')), false,
    'B picked up main\'s content — it rebased onto the project branch, not its feature');
  // (4) B's own work survived.
  assert.equal(await exists(path.join(b.worktreePath, 'b.js')), true);
  // (5) And B is genuinely on top of the feature, not merely holding its files.
  assert.equal(
    await gitCode(b.worktreePath, 'merge-base', '--is-ancestor', feature.branch, b.branch), 0,
    'the feature branch is not an ancestor of the task branch after the rebase',
  );
});


// ---------------------------------------------------------------------------
// T19-T22 — worktree name aliasing on the create / base / dependents paths.
// ---------------------------------------------------------------------------

// baseWorktree is the foreign key listDependentWorktrees matches on. Persisting
// the caller's spelling would produce a record no dependents query can see.
test('T19: a baseWorktree named by bare slug is persisted canonically', async () => {
  await makeRealRepo('demo');
  const feature = await createWorktree('demo', { name: 'auth' });
  assert.equal(feature.worktreeName, 'demo_worktree_auth');

  const task = await createWorktree('demo', { baseWorktree: 'auth' });
  assert.equal(task.baseWorktree, 'demo_worktree_auth',
    'the stored foreign key is canonical, not the caller\'s spelling');
  assert.equal(task.parentPath, feature.worktreePath);

  assert.deepEqual(await listDependentWorktrees('demo', 'demo_worktree_auth'), [task.worktreeName]);
  assert.deepEqual(await listDependentWorktrees('demo', 'auth'), [task.worktreeName],
    'listDependentWorktrees aliases too');
});

// THE safety test. removeWorktree feeds listDependentWorktrees; with a raw bare
// slug that returns [], the dependents refusal is silently bypassed and the
// base's branch is deleted out from under its child. Asserting the child
// SURVIVES — not merely that it threw — is what makes this a safety assertion.
test('T20: removeWorktree by bare slug still refuses a base that has dependents', async () => {
  await makeRealRepo('demo');
  const feature = await createWorktree('demo', { name: 'auth' });
  const task = await createWorktree('demo', { baseWorktree: feature.worktreeName });

  await assert.rejects(
    () => removeWorktree('demo', 'auth'),
    (e) => {
      assert.equal(e.statusCode, 409);
      assert.match(e.message, /WORKTREE_HAS_DEPENDENTS|is the base for/);
      return true;
    },
  );

  assert.equal(await exists(task.worktreePath), true, 'the CHILD must survive the refused delete');
  assert.equal(await exists(feature.worktreePath), true);
  assert.equal(await branchExists(path.join(projectsRoot, 'demo'), feature.branch), true);
  assert.deepEqual(await listDependentWorktrees('demo', feature.worktreeName), [task.worktreeName]);
});

test('T21: syncWorktree by bare slug still returns the dependents refusal', async () => {
  await makeRealRepo('demo');
  const feature = await createWorktree('demo', { name: 'auth' });
  await createWorktree('demo', { baseWorktree: feature.worktreeName });

  const r = await syncWorktree('demo', 'auth');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WORKTREE_HAS_DEPENDENTS');
  assert.deepEqual(r.dependents.length, 1);

  const m = await mergeWorktreeIntoParent('demo', 'auth');
  assert.equal(m.ok, false);
  assert.equal(m.code, 'WORKTREE_HAS_DEPENDENTS');
});

// Create side: one exact `<project>_worktree_` prefix is stripped before
// slugifying, so a caller echoing a full dir name back into create_worktree
// names the worktree they meant rather than a mangled sibling.
test('T22: create strips one <project>_worktree_ prefix before slugifying', async () => {
  await makeRealRepo('demo');

  // 1. Both "don't strip" and "slugify before stripping" would yield
  //    demo_worktree_demo-worktree-x.
  const prefixed = await createWorktree('demo', { name: 'demo_worktree_x' });
  assert.equal(prefixed.worktreeName, 'demo_worktree_x');
  assert.equal(prefixed.branch, 'code-conductor/x');

  // 2. The two spellings collide — i.e. they name the same worktree.
  await assert.rejects(
    () => createWorktree('demo', { name: 'x' }),
    (e) => { assert.equal(e.statusCode, 409); assert.match(e.message, /code-conductor\/x/); return true; },
  );

  // 3. The direct "same directory either way" assertion.
  await removeWorktree('demo', 'demo_worktree_x');
  const bare = await createWorktree('demo', { name: 'x' });
  assert.equal(bare.worktreeName, prefixed.worktreeName);
  assert.equal(bare.branch, prefixed.branch);

  // 4. The bound: only the literal underscored prefix, and strip-then-validate
  //    (an empty remainder still 400s rather than returning the unstripped name).
  const dashed = await createWorktree('demo', { name: 'demo-worktree-y' });
  assert.equal(dashed.worktreeName, 'demo_worktree_demo-worktree-y');

  // 5. EXACTLY once, not greedily. A doubled prefix strips one level only, so
  //    the remaining `_` slugifies to `-`. A strip-every-occurrence
  //    implementation would yield demo_worktree_x — a different worktree.
  const doubled = await createWorktree('demo', { name: 'demo_worktree_demo_worktree_z' });
  assert.equal(doubled.worktreeName, 'demo_worktree_demo-worktree-z');
  assert.equal(doubled.branch, 'code-conductor/demo-worktree-z');
  await assert.rejects(
    () => createWorktree('demo', { name: 'demo_worktree_' }),
    (e) => { assert.equal(e.statusCode, 400); assert.match(e.message, /no usable characters/); return true; },
  );
});
