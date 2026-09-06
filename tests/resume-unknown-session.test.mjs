// Resume pre-flight guard: a spawn_instance({resume}) with a resume id that has
// no resumable conversation on disk (mistyped/bogus, or a marker-only crash
// stub) must be soft-refused BEFORE any subprocess is spawned — rather than
// launching `claude --resume <bogus>`, which exits 1 ("No conversation found")
// and crash-loops. Regression for the code-share worker that crash-looped on a
// conductor-mistyped sessionId after a restart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, seedSessionJsonl } from './helpers.mjs';
import { hasResumableConversation, writeSessionMetadata } from '../src/transcript.ts';
import { listWorktrees } from '../src/worktrees.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

// Reuse the model-resume.test.mjs pattern for an isolated CLAUDE_PROJECTS_ROOT.
async function withTmpClaudeRoot(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-unknown-'));
  const claudeProjects = path.join(tmpDir, '.claude', 'projects');
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = claudeProjects;
  try {
    await fn({ tmpDir, claudeProjects });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Shared with tests/playbook-enforce.test.mjs — one implementation of "what the
// CLI would have written", since the fake engine writes no transcript.
const seedJsonl = seedSessionJsonl;

// --- Unit tests: hasResumableConversation ---

test('hasResumableConversation: true when the jsonl has a user record', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
    await seedJsonl(claudeProjects, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ]);
    assert.equal(await hasResumableConversation({ cwd, sessionId }), true);
  });
});

test('hasResumableConversation: true when the jsonl has an assistant record', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'bbbbbbbb-1111-2222-3333-444444444444';
    await seedJsonl(claudeProjects, cwd, sessionId, [
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8' } },
    ]);
    assert.equal(await hasResumableConversation({ cwd, sessionId }), true);
  });
});

test('hasResumableConversation: false for a marker-only crash stub (no conversation)', async () => {
  await withTmpClaudeRoot(async ({ tmpDir }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'cccccccc-1111-2222-3333-444444444444';
    // Exactly the shape a crash-during-resume leaves behind: our best-effort
    // markers, no user/assistant lines. This is the real -4470 stub shape.
    await writeSessionMetadata({
      cwd, sessionId, leafUuid: 'leaf-x', mode: 'bypassPermissions',
    });
    assert.equal(await hasResumableConversation({ cwd, sessionId }), false);
  });
});

test('hasResumableConversation: false when the jsonl does not exist (ENOENT)', async () => {
  await withTmpClaudeRoot(async ({ tmpDir }) => {
    const cwd = path.join(tmpDir, 'proj');
    assert.equal(
      await hasResumableConversation({ cwd, sessionId: 'dddddddd-1111-2222-3333-444444444444' }),
      false,
    );
  });
});

// --- Integration: spawn_instance({resume}) MCP handler ---

test('spawn_instance({resume:<bogus>, project}) soft-refuses SESSION_UNKNOWN and spawns no subprocess', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const argvDumpFile = path.join(os.tmpdir(), `resume-unknown-argv-${process.pid}.txt`);
  const prevArgvDump = process.env.FAKE_CLAUDE_ARGV_DUMP;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const { spawnInstance, respawnInstance } = await import('../src/mcp/handlers.ts');

    // A well-specified but mistyped resume id: project is supplied, so the
    // findSessionLocation "project required" net is bypassed — this is the
    // exact incident shape.
    const bogus = 'e171ceb7-949a-4470-b470-bdea99458950';
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDumpFile;
    try { await fs.rm(argvDumpFile, { force: true }); } catch { /* best-effort */ }

    const res = await spawnInstance({ resume: bogus, project: 'demo', mode: 'bypassPermissions' }, { instances: ctx.instances });
    assert.deepEqual(
      { ok: res.ok, code: res.code, sessionId: res.sessionId },
      { ok: false, code: 'SESSION_UNKNOWN', sessionId: bogus },
    );

    // No Instance was registered (no phantom crashed worker) ...
    assert.equal(ctx.instances.anyForSession(bogus), null,
      'no phantom Instance registered for the refused resume id');

    // ... and no `claude` subprocess was launched: the fake-claude argv dump
    // is written synchronously on startup, so its absence proves no spawn.
    // Give any (incorrect) async spawn a beat to have appeared.
    await new Promise(r => setTimeout(r, 200));
    let spawned = true;
    try { await fs.stat(argvDumpFile); } catch { spawned = false; }
    assert.equal(spawned, false, 'refused resume must not spawn a claude subprocess');

    // Follow-up respawn on the same bogus id soft-refuses SESSION_NOT_LIVE
    // (there is no in-memory instance to respawn, precisely because the spawn
    // was refused before registration).
    const rr = await respawnInstance({ sessionId: bogus }, { instances: ctx.instances });
    assert.equal(rr.ok, false);
    assert.equal(rr.code, 'SESSION_NOT_LIVE');
  } finally {
    if (prevArgvDump === undefined) delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    else process.env.FAKE_CLAUDE_ARGV_DUMP = prevArgvDump;
    try { await fs.rm(argvDumpFile, { force: true }); } catch { /* best-effort */ }
    await ctx.close();
  }
});

test('spawn_instance({resume:<marker-only stub>, project}) soft-refuses SESSION_UNKNOWN', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const { spawnInstance } = await import('../src/mcp/handlers.ts');

    const stubId = 'facade00-1111-2222-3333-444444444444';
    const projectPath = path.join(ctx.projectsRoot, 'demo');
    // A crash stub: markers only, no user/assistant records.
    await writeSessionMetadata({
      cwd: projectPath, sessionId: stubId, leafUuid: 'leaf-y', mode: 'bypassPermissions',
    });

    const res = await spawnInstance({ resume: stubId, project: 'demo', mode: 'bypassPermissions' }, { instances: ctx.instances });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_UNKNOWN');
  } finally {
    await ctx.close();
  }
});

test('spawn_instance({resume:<real transcript>, project}) still spawns normally (regression)', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const { spawnInstance } = await import('../src/mcp/handlers.ts');

    const goodId = 'beefcafe-1111-2222-3333-444444444444';
    const projectPath = path.join(ctx.projectsRoot, 'demo');
    // A real (resumable) transcript: at least one user + one assistant record.
    await seedJsonl(ctx.claudeProjectsRoot, projectPath, goodId, [
      { type: 'user', message: { role: 'user', content: 'do the thing' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8' } },
    ]);

    const res = await spawnInstance({ resume: goodId, project: 'demo', mode: 'bypassPermissions' }, { instances: ctx.instances });
    assert.ok(!('ok' in res && res.ok === false), 'a resumable transcript must not be refused');
    assert.equal(res.sessionId, goodId, 'resumed session keeps its id');
    // The subprocess actually launches and reaches idle.
    await waitFor(() => {
      const inst = ctx.instances.anyForSession(goodId);
      return inst && inst.status === 'idle';
    });
  } finally {
    await ctx.close();
  }
});

test('spawn_instance({resume:<bogus>}) with NO project still throws the existing "project required" 400', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const { spawnInstance } = await import('../src/mcp/handlers.ts');
    // No project supplied + an unlocatable id: the older findSessionLocation
    // net fires first (this is the path that caught the conductor's -4830
    // mistype). spawnInstance only soft-refuses SESSION_UNKNOWN, so the 400
    // propagates as a throw.
    await assert.rejects(
      () => spawnInstance({ resume: 'ffffffff-1111-2222-3333-444444444444', mode: 'bypassPermissions' }, { instances: ctx.instances }),
      (e) => e.statusCode === 400 && /project required/.test(e.message),
    );
  } finally {
    await ctx.close();
  }
});

// --- The stranded-worktree leak (card 2026-0358, fix 3) ---

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// `POST /api/projects` git-inits but never commits, and `git worktree add`
// needs a branch HEAD — so a project with no commit could not grow a worktree
// at all, and "the count did not change" would be true for the wrong reason.
async function commitProject(projectPath) {
  await git(projectPath, 'config', 'user.email', 'test@example.com');
  await git(projectPath, 'config', 'user.name', 'test');
  await git(projectPath, 'config', 'commit.gpgsign', 'false');
  await git(projectPath, 'add', '-A');
  await git(projectPath, 'commit', '-q', '-m', 'initial');
}

test('a resume never creates a worktree, even when the caller asks for one', async () => {
  // INVARIANT: `resume` + `worktree:true` is refused BEFORE createWorktree()
  // runs, so a resume that cannot proceed strands nothing. A fresh worktree is a
  // fresh cwd and ~/.claude/projects/<encoded-cwd>/ is keyed on that path, so the
  // combination can never hold the resumed transcript — it is contradictory, not
  // unlucky.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    await commitProject(path.join(ctx.projectsRoot, 'demo'));
    const { spawnInstance } = await import('../src/mcp/handlers.ts');

    // PREMISE GUARD: this project really can grow a worktree, so the
    // count-unchanged assertion below is about the refusal and not about a
    // createWorktree() that would have failed anyway.
    const fresh = await spawnInstance(
      { project: 'demo', createWorktree: true, mode: 'bypassPermissions' }, { instances: ctx.instances });
    assert.ok(fresh.sessionId, `the premise spawn must succeed: ${JSON.stringify(fresh)}`);
    const before = (await listWorktrees('demo')).map(w => w.worktreeName);
    assert.equal(before.length, 1, 'premise: createWorktree:true does create one here');

    const bogus = 'e171ceb7-949a-4470-b470-bdea99458950';
    let threw = null;
    try {
      await spawnInstance(
        { resume: bogus, project: 'demo', createWorktree: true, mode: 'bypassPermissions' },
        { instances: ctx.instances });
    } catch (e) { threw = e; }

    // The load-bearing assertion: nothing was stranded on disk or in the store.
    assert.deepEqual((await listWorktrees('demo')).map(w => w.worktreeName), before,
      'a resume that asks for a worktree must strand none');
    assert.ok(threw, 'the contradictory combination must be refused, not silently honoured');
    assert.equal(threw.statusCode, 400);
    assert.match(threw.message, /resume/);
  } finally {
    await ctx.close();
  }
});

test('the surfaced SESSION_UNKNOWN names the cwd it probed and leaks no backing id', async () => {
  // INVARIANT (the negative half is the valuable one): the refusal says WHERE it
  // looked — without it, a resume refused at the wrong cwd is indistinguishable
  // from a bad id, which is what made the incident read as a mistype for hours —
  // and it still echoes the caller's own handle, never the ~/.claude UUID that
  // `resume` has been rebound to by the time the throw happens.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const projectPath = path.join(ctx.projectsRoot, 'demo');
    const { spawnInstance } = await import('../src/mcp/handlers.ts');

    // A real session, so its public id and backing id differ — and NO transcript
    // seeded, so resuming it refuses at a cwd that genuinely holds nothing.
    const fresh = await spawnInstance({ project: 'demo', mode: 'bypassPermissions' }, { instances: ctx.instances });
    const handle = fresh.sessionId;
    await waitFor(() => ctx.instances.anyForSession(handle)?.status === 'idle');
    const backing = ctx.instances.anyForSession(handle).backingSessionId;
    assert.notEqual(backing, handle, 'premise: the two ids must differ, or the leak assertion is vacuous');
    await ctx.instances.remove(ctx.instances.anyForSession(handle).id);

    const res = await spawnInstance({ resume: handle, project: 'demo', mode: 'bypassPermissions' }, { instances: ctx.instances });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_UNKNOWN');
    assert.equal(res.sessionId, handle, 'the refusal echoes the handle the caller passed');
    assert.ok(res.reason.includes(projectPath),
      `the refusal must name the cwd it probed; got: ${res.reason}`);
    assert.ok(!res.reason.includes(backing),
      `the refusal must not surface the backing id; got: ${res.reason}`);
  } finally {
    await ctx.close();
  }
});
