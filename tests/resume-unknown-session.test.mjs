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
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';
import { hasResumableConversation, writeSessionMetadata } from '../src/transcript.js';

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

async function seedJsonl(claudeProjects, cwd, sessionId, records) {
  const dir = path.join(claudeProjects, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const body = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), body);
}

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
      cwd, sessionId, leafUuid: 'leaf-x', permissionMode: 'bypassPermissions',
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
    const { spawnInstance, respawnInstance } = await import('../src/mcp/handlers.js');

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
    const { spawnInstance } = await import('../src/mcp/handlers.js');

    const stubId = 'facade00-1111-2222-3333-444444444444';
    const projectPath = path.join(ctx.projectsRoot, 'demo');
    // A crash stub: markers only, no user/assistant records.
    await writeSessionMetadata({
      cwd: projectPath, sessionId: stubId, leafUuid: 'leaf-y', permissionMode: 'bypassPermissions',
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
    const { spawnInstance } = await import('../src/mcp/handlers.js');

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
    const { spawnInstance } = await import('../src/mcp/handlers.js');
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
