// Integration and unit tests for the context-window-variant preservation
// across resume. The bug: sessions spawned with claude-opus-4-8[200k]
// came back as the 1M variant on resume because the [200k] suffix is
// orchestrator-only and was never persisted to the session jsonl.
//
// The fix: _writeSessionMetadata() now appends an `orchestrator-model`
// marker with the full model string (incl. [200k]/[1m] suffix).
// readLastSessionModel() prefers that marker over the raw API-response
// model field, so the suffix survives a server restart.

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

test('writeSessionMetadata writes orchestrator-model marker; readLastSessionModel returns it', async () => {
  await withTmpClaudeRoot(async ({ tmpDir }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeSessionMetadata({
      cwd, sessionId, leafUuid: 'leaf-1', permissionMode: 'bypassPermissions',
      model: 'claude-opus-4-8[200k]',
    });
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, 'claude-opus-4-8[200k]');
  });
});

test('writeSessionMetadata without model omits marker (null-safe)', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
    await writeSessionMetadata({
      cwd, sessionId, leafUuid: 'leaf-2', permissionMode: 'bypassPermissions',
      // no model
    });
    // File exists with just the two standard markers
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    const text = await fs.readFile(path.join(sessionDir, `${sessionId}.jsonl`), 'utf8');
    const lines = text.trim().split('\n').map(l => JSON.parse(l));
    assert.ok(!lines.some(l => l.type === 'orchestrator-model'), 'no marker when model is absent');
    // readLastSessionModel returns null (no assistant messages either)
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, null);
  });
});

test('readLastSessionModel falls back to assistant message model (legacy sessions)', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    await fs.mkdir(sessionDir, { recursive: true });
    // Write only a raw assistant message (no orchestrator-model marker)
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }) + '\n',
    );
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, 'claude-sonnet-4-6');
  });
});

test('readLastSessionModel prefers orchestrator-model marker over assistant message model', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'cccccccc-dddd-eeee-ffff-000000000000';
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    await fs.mkdir(sessionDir, { recursive: true });
    // Bare model from CLI in assistant message, but orchestrator-model marker has [200k]
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8' } }) + '\n' +
      JSON.stringify({ type: 'orchestrator-model', model: 'claude-opus-4-8[200k]', sessionId }) + '\n',
    );
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, 'claude-opus-4-8[200k]');
  });
});

// --- Integration test: full server path ---

test('resume via POST /instances sets CLAUDE_CODE_DISABLE_1M_CONTEXT=1 when session was [200k]', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const envDumpFile = path.join(os.tmpdir(), `model-resume-env-${process.pid}.txt`);
  const prevEnvDump = process.env.FAKE_CLAUDE_ENV_DUMP;

  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    // Spawn first instance with 200k model
    const r1 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      model: 'claude-opus-4-8[200k]',
    });
    assert.equal(r1.status, 201);
    const id1 = r1.body.id;
    await waitFor(() => ctx.instances.get(id1).status === 'idle');

    const inst1 = ctx.instances.get(id1);
    const sessionId = inst1.sessionId;

    // Send a prompt so the fake-claude emits events with uuid fields.
    // The result event uuid triggers _lastLeafUuid which enables _writeSessionMetadata().
    inst1.prompt('hello');
    await waitFor(() => ctx.instances.get(id1).status === 'idle');

    // Verify the jsonl now has an orchestrator-model marker
    const projectPath = path.join(ctx.projectsRoot, 'demo');
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
    const jsonlText = await fs.readFile(jsonlPath, 'utf8');
    const jsonlLines = jsonlText.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const modelMarker = jsonlLines.find(l => l.type === 'orchestrator-model');
    assert.ok(modelMarker, 'orchestrator-model marker written to session jsonl');
    assert.equal(modelMarker.model, 'claude-opus-4-8[200k]', 'marker preserves [200k] suffix');

    // Kill the first instance — create() guards against resuming a session
    // that's still attached to a live instance (409 conflict).
    await api(ctx.baseUrl, 'DELETE', `/api/instances/${id1}`);

    // Resume the session via POST /instances with no explicit model.
    // Use FAKE_CLAUDE_ENV_DUMP so the resumed subprocess captures its env.
    process.env.FAKE_CLAUDE_ENV_DUMP = envDumpFile;
    const r2 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      resume: sessionId,
      // model intentionally omitted — must be recovered from jsonl
    });
    assert.equal(r2.status, 201);
    const id2 = r2.body.id;
    await waitFor(() => ctx.instances.get(id2).status === 'idle');

    // Wait for fake-claude's synchronous env dump to land on disk —
    // the child process writes it at startup before reading stdin, but
    // the orchestrator may declare 'idle' before the OS has flushed it.
    await waitFor(async () => {
      try { await fs.stat(envDumpFile); return true; } catch { return false; }
    });

    // The resumed subprocess must have CLAUDE_CODE_DISABLE_1M_CONTEXT=1
    const envDump = await fs.readFile(envDumpFile, 'utf8');
    const contextVar = envDump.split('\n').filter(Boolean)
      .find(l => l.startsWith('CLAUDE_CODE_DISABLE_1M_CONTEXT='));
    assert.ok(contextVar, 'CLAUDE_CODE_DISABLE_1M_CONTEXT present in resumed subprocess env');
    assert.equal(contextVar, 'CLAUDE_CODE_DISABLE_1M_CONTEXT=1',
      'resumed subprocess forces 200k context window');
  } finally {
    if (prevEnvDump === undefined) delete process.env.FAKE_CLAUDE_ENV_DUMP;
    else process.env.FAKE_CLAUDE_ENV_DUMP = prevEnvDump;
    try { await fs.rm(envDumpFile, { force: true }); } catch { /* best-effort */ }
    await ctx.close();
  }
});
