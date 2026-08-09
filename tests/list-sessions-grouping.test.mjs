// list_sessions end to end, over a REAL project + worktree on disk.
//
// Two things can only be proven here, not at the renderer:
//
//   1. The resumes-hot flag reads the EFFECTIVE resume mode. That decision is
//      made in listSessionsForCwdWithCounts (src/projects.ts) as it walks the
//      transcripts — a renderer test that hand-injects `resumeMode` pins the
//      presentation and leaves the decision untested, so a scan that reported
//      the RAW record would sail through it while telling a reader that an
//      unrecorded (and therefore hot) session is safe to resume.
//
//   2. Groups are ordered main-checkout-first. The renderer is handed groups
//      already sorted, so feeding it a pre-sorted array proves nothing about
//      the sort itself, which lives in the handler.
//
// Both need sessions on disk in two cwds of one project, so the fixture is a
// real git repo with a real worktree.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { markSessionMode, getSessionMode } from '../src/sessionModes.ts';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

const git = (cwd, ...args) => execFileP('git', args, { cwd });

async function makeRealRepo(name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

let nextRpcId = 1;
async function call(name, args = {}) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result.content[0].text;
}

// Put a resumable transcript on disk for a cwd. No instance, no sidecar entry
// unless the caller adds one — i.e. exactly the shape of a legacy session.
async function seedSession(cwd, sid) {
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`),
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n');
}

// The rendered line for a session id, wherever in the grouping it landed.
const rowFor = (text, sid) => text.split('\n').map(l => l.trim()).find(l => l.startsWith(sid));

async function repoWithWorktree() {
  const repoPath = await makeRealRepo('demo');
  const created = JSON.parse(await call('create_worktree', { project: 'demo' }));
  const wtPath = created.worktreePath ?? created.worktree?.worktreePath;
  assert.ok(wtPath, `create_worktree gave no path: ${JSON.stringify(created)}`);
  return { repoPath, wtPath, wtName: path.basename(wtPath) };
}

// ---------- the effective-mode rule, decided during the disk scan ----------

const SID_NO_RECORD = '11111111-1111-4111-8111-111111111111';
const SID_PLAN = '22222222-2222-4222-8222-222222222222';

test('a session on disk with NO recorded mode renders resumes-hot', async () => {
  // The decision under test is in the scan, not the renderer: nothing here
  // injects a resumeMode. A scan reporting the raw record would leave this row
  // unflagged while spawn_instance({resume}) still brought it up ungated.
  const repoPath = await makeRealRepo('demo');
  await seedSession(repoPath, SID_NO_RECORD);
  assert.equal(await getSessionMode(SID_NO_RECORD), null, 'fixture must genuinely have no record');

  const out = await call('list_sessions', { project: 'demo' });
  const row = rowFor(out, SID_NO_RECORD);
  assert.ok(row, `the seeded session must be listed:\n${out}`);
  assert.match(row, /resumes-hot/,
    `an unrecorded session resumes bypassPermissions and MUST be flagged:\n${out}`);
});

test('a session recorded as plan renders no flag — so the flag is not a constant', async () => {
  const repoPath = await makeRealRepo('demo');
  await seedSession(repoPath, SID_PLAN);
  await markSessionMode(SID_PLAN, 'plan');

  const out = await call('list_sessions', { project: 'demo' });
  const row = rowFor(out, SID_PLAN);
  assert.ok(row, `the seeded session must be listed:\n${out}`);
  assert.ok(!row.includes('resumes-hot'), `a recorded plan session does not resume hot:\n${out}`);
});

test('both rows in ONE listing: recorded-plan cold, unrecorded hot', async () => {
  // The pair in a single scan. A scan that ignored the record entirely, or one
  // that reported it raw, fails on exactly one of these two rows.
  const repoPath = await makeRealRepo('demo');
  await seedSession(repoPath, SID_NO_RECORD);
  await seedSession(repoPath, SID_PLAN);
  await markSessionMode(SID_PLAN, 'plan');

  const out = await call('list_sessions', { project: 'demo' });
  assert.match(rowFor(out, SID_NO_RECORD), /resumes-hot/, `unrecorded must flag:\n${out}`);
  assert.ok(!rowFor(out, SID_PLAN).includes('resumes-hot'), `recorded plan must not flag:\n${out}`);
});

// ---------- grouping: main checkout first, worktrees reachable ----------

test('the main checkout group precedes its worktree groups', async () => {
  const { repoPath, wtPath, wtName } = await repoWithWorktree();
  const mainSid = '33333333-3333-4333-8333-333333333333';
  const wtSid = '44444444-4444-4444-8444-444444444444';
  await seedSession(repoPath, mainSid);
  await seedSession(wtPath, wtSid);

  const out = await call('list_sessions', { project: 'demo' });
  const heads = out.split('\n').filter(l => /^ {2}(main checkout|worktree )/.test(l));
  assert.equal(heads.length, 2, `expected a main-checkout and a worktree group:\n${out}`);
  assert.match(heads[0], /^ {2}main checkout /,
    `the main checkout must lead its project — it is the group that always exists:\n${out}`);
  assert.match(heads[1], new RegExp(`^ {2}worktree ${wtName} `));
  assert.ok(out.indexOf(mainSid) < out.indexOf(wtSid),
    `main-checkout sessions must render before worktree sessions:\n${out}`);
});

test('`project` alone reaches worktree sessions — the scope that used to need `worktree`', async () => {
  // The merge's headline behaviour change: list_sessions(project) used to cover
  // the main checkout only, so a worktree session was invisible without naming
  // its worktree.
  const { repoPath, wtPath } = await repoWithWorktree();
  const mainSid = '55555555-5555-4555-8555-555555555555';
  const wtSid = '66666666-6666-4666-8666-666666666666';
  await seedSession(repoPath, mainSid);
  await seedSession(wtPath, wtSid);

  const out = await call('list_sessions', { project: 'demo' });
  assert.ok(rowFor(out, mainSid), `main-checkout session missing:\n${out}`);
  assert.ok(rowFor(out, wtSid), `worktree session must appear without naming the worktree:\n${out}`);
  assert.match(out, /^SESSIONS \(live 0 · inactive 2 · archived 0\) {2}project demo$/m);
});

test('`worktree` narrows to that worktree alone', async () => {
  const { repoPath, wtPath, wtName } = await repoWithWorktree();
  const mainSid = '77777777-7777-4777-8777-777777777777';
  const wtSid = '88888888-8888-4888-8888-888888888888';
  await seedSession(repoPath, mainSid);
  await seedSession(wtPath, wtSid);

  const out = await call('list_sessions', { project: 'demo', worktree: wtName });
  assert.ok(rowFor(out, wtSid), `the worktree's own session must be listed:\n${out}`);
  assert.ok(!rowFor(out, mainSid), `narrowing must exclude the main checkout:\n${out}`);
});

test("a worktree header labels its divergence as measured against the base", async () => {
  // Unlabelled, the number reads as the same measurement the main checkout
  // declines to make; `vs base` is what makes that silence legible.
  const { wtPath, wtName } = await repoWithWorktree();
  await seedSession(wtPath, '99999999-9999-4999-8999-999999999999');

  const out = await call('list_sessions', { project: 'demo' });
  const head = out.split('\n').find(l => l.includes(`worktree ${wtName}`));
  assert.match(head, /↑\d+ ↓\d+ vs base/, `worktree divergence must be labelled:\n${out}`);
  const mainHead = out.split('\n').find(l => /^ {2}main checkout /.test(l));
  assert.ok(!/↑|↓/.test(mainHead),
    `the main checkout answers a different question and must show no divergence:\n${out}`);
});
