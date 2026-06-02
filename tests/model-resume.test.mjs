// Tests for model recovery across resume. The window is no longer
// persisted — it's a pure function of the family (see canonicalizeModel in
// src/modelVersions.js) — so resume recovers only the bare model id the CLI
// recorded in the session jsonl and re-derives the window from it. No
// `orchestrator-model` marker is written to Claude's jsonl anymore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';
import { readLastSessionModel, writeSessionMetadata } from '../src/transcript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

// Helper: create a temp dir with a fake CLAUDE_PROJECTS_ROOT and clean up after.
async function withTmpClaudeRoot(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-resume-'));
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

// --- Unit tests: transcript module ---

test('writeSessionMetadata writes only last-prompt + permission-mode (no orchestrator-model)', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeSessionMetadata({
      cwd, sessionId, leafUuid: 'leaf-1', permissionMode: 'bypassPermissions',
    });
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    const text = await fs.readFile(path.join(sessionDir, `${sessionId}.jsonl`), 'utf8');
    const lines = text.trim().split('\n').map(l => JSON.parse(l));
    const types = lines.map(l => l.type).sort();
    assert.deepEqual(types, ['last-prompt', 'permission-mode']);
    assert.ok(!lines.some(l => l.type === 'orchestrator-model'),
      'the orchestrator no longer writes a custom marker into Claude\'s jsonl');
  });
});

test('readLastSessionModel returns the bare assistant message model', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }) + '\n',
    );
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, 'claude-sonnet-4-6');
  });
});

test('readLastSessionModel returns null when no assistant line is present', async () => {
  await withTmpClaudeRoot(async ({ tmpDir }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'cccccccc-dddd-eeee-ffff-000000000000';
    await writeSessionMetadata({
      cwd, sessionId, leafUuid: 'leaf-2', permissionMode: 'bypassPermissions',
    });
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, null);
  });
});

// --- Integration test: full server path ---

test('resume recovers the bare model and re-derives the window (Sonnet → [1m]), no marker, no disable flag', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const argvDumpFile = path.join(os.tmpdir(), `model-resume-argv-${process.pid}.txt`);
  const envDumpFile = path.join(os.tmpdir(), `model-resume-env-${process.pid}.txt`);
  const prevArgvDump = process.env.FAKE_CLAUDE_ARGV_DUMP;
  const prevEnvDump = process.env.FAKE_CLAUDE_ENV_DUMP;

  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    // Spawn with a Sonnet family model — canonicalised to [1m] at spawn.
    const r1 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(r1.status, 201);
    const id1 = r1.body.id;
    await waitFor(() => ctx.instances.get(id1).status === 'idle');

    const inst1 = ctx.instances.get(id1);
    const sessionId = inst1.sessionId;
    assert.equal(inst1.model, 'claude-sonnet-4-6[1m]', 'spawn canonicalises Sonnet to [1m]');

    // Run a turn so _writeSessionMetadata appends last-prompt/permission-mode.
    inst1.prompt('hello');
    await waitFor(() => ctx.instances.get(id1).status === 'idle');

    const projectPath = path.join(ctx.projectsRoot, 'demo');
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);

    // The CLI records a BARE model id in its assistant lines; fake-claude
    // doesn't write the jsonl, so seed that line to mirror the real CLI.
    await fs.appendFile(jsonlPath,
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }) + '\n');

    // No orchestrator-model marker should ever have been written.
    const jsonlLines = (await fs.readFile(jsonlPath, 'utf8')).trim().split('\n')
      .filter(Boolean).map(l => JSON.parse(l));
    assert.ok(!jsonlLines.some(l => l.type === 'orchestrator-model'),
      'no orchestrator-model marker is written to the session jsonl');

    // Kill the first instance (create() refuses to resume a live session).
    await api(ctx.baseUrl, 'DELETE', `/api/instances/${id1}`);

    // Resume with no explicit model — must recover bare then canonicalise.
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDumpFile;
    process.env.FAKE_CLAUDE_ENV_DUMP = envDumpFile;
    const r2 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      resume: sessionId,
    });
    assert.equal(r2.status, 201);
    const id2 = r2.body.id;
    await waitFor(() => ctx.instances.get(id2).status === 'idle');

    assert.equal(ctx.instances.get(id2).model, 'claude-sonnet-4-6[1m]',
      'resumed instance re-derives the 1M window from the recovered family');

    // The resumed subprocess must launch with the canonical [1m] model and
    // must NOT carry the (now-removed) disable flag.
    await waitFor(async () => { try { await fs.stat(argvDumpFile); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDumpFile, 'utf8')).split('\n').filter(Boolean);
    const mi = argv.indexOf('--model');
    assert.ok(mi >= 0 && argv[mi + 1] === 'claude-sonnet-4-6[1m]',
      'resumed subprocess is launched with --model claude-sonnet-4-6[1m]');

    const envDump = await fs.readFile(envDumpFile, 'utf8');
    assert.ok(!envDump.split('\n').some(l => l.startsWith('CLAUDE_CODE_DISABLE_1M_CONTEXT=')),
      'CLAUDE_CODE_DISABLE_1M_CONTEXT must never be set');
  } finally {
    if (prevArgvDump === undefined) delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    else process.env.FAKE_CLAUDE_ARGV_DUMP = prevArgvDump;
    if (prevEnvDump === undefined) delete process.env.FAKE_CLAUDE_ENV_DUMP;
    else process.env.FAKE_CLAUDE_ENV_DUMP = prevEnvDump;
    try { await fs.rm(argvDumpFile, { force: true }); } catch { /* best-effort */ }
    try { await fs.rm(envDumpFile, { force: true }); } catch { /* best-effort */ }
    await ctx.close();
  }
});
