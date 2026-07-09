import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd, orchStoreRoot } from '../src/projects.js';
import {
  pendingTempCleanupPath,
  writePendingTempCleanup,
  sweepPendingTempCleanup,
} from '../src/tempCleanup.js';
import { loadAllArchived, isArchived } from '../src/archivedSessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// One server shared across the file; each test gets a fresh PROJECTS_ROOT (so
// archived-sessions / temp sidecars start empty) and spawned instances are
// cleared between tests. Tests use the per-test `claudeProjectsRoot` var set in
// beforeEach when planting jsonl, NOT the boot-time root.
let ctx, baseUrl, instances, claudeProjectsRoot, home;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// Helper: materialise a fake .jsonl for an instance (fake-claude doesn't write
// to ~/.claude/projects, so we do it ourselves to test the archive path).
async function materializeJsonl(claudeProjectsRoot, inst, content = '{"type":"user","uuid":"u1"}\n') {
  const dir = path.join(claudeProjectsRoot, encodeCwd(inst.cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${inst.sessionId}.jsonl`);
  await fs.writeFile(file, content);
  return file;
}

test('killing a temp instance archives the session — .jsonl kept, archived flag set', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'archivetest' });

    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'archivetest', temp: true });
    assert.equal(res.status, 201);
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;

    const jsonlFile = await materializeJsonl(claudeProjectsRoot, inst);

    // Kill the instance via the REST endpoint.
    const killRes = await api(baseUrl, 'DELETE', `/api/instances/${inst.id}`);
    assert.equal(killRes.status, 200);
    await waitFor(() => !instances.get(inst.id));

    // .jsonl must still exist (archived, not deleted).
    await fs.access(jsonlFile);

    // archived-sessions.json must contain the session.
    await waitFor(async () => (await isArchived(sid)));
    assert.equal(await isArchived(sid), true);

    // temp-sessions.json must NOT contain it any more.
    const { loadAllTemps } = await import('../src/tempSessions.js');
    assert.equal((await loadAllTemps()).has(sid), false);
  }
});

test('archived session appears in list_sessions with archived:true, excluded from summarizeSessions count', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'archivelist' });

    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'archivelist', temp: true });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    await materializeJsonl(claudeProjectsRoot, inst);

    // Kill so it gets archived.
    await api(baseUrl, 'DELETE', `/api/instances/${inst.id}`);
    await waitFor(() => !instances.get(inst.id));
    await waitFor(async () => (await isArchived(sid)));

    // Archived sessions are excluded from the default list.
    const listRes = await api(baseUrl, 'GET', `/api/projects/archivelist/sessions`);
    assert.equal(listRes.status, 200);
    const sessions = listRes.body;
    assert.ok(!sessions.find(s => s.sessionId === sid), 'archived session must not appear in default list');

    // With includeArchived=1 the session appears with archived:true.
    const inclRes = await api(baseUrl, 'GET', `/api/projects/archivelist/sessions?includeArchived=1`);
    assert.equal(inclRes.status, 200);
    const found = inclRes.body.find(s => s.sessionId === sid);
    assert.ok(found, 'archived session should appear with includeArchived=1');
    assert.equal(found.archived, true, 'archived flag must be true');

    // The projects summary count excludes archived sessions.
    const projRes = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(projRes.status, 200);
    const proj = projRes.body.find(p => p.name === 'archivelist');
    assert.ok(proj, 'project should exist');
    // sessions.count should be 0 (the only session is archived).
    assert.equal(proj.sessions?.count ?? 0, 0, 'archived session must not count toward summary');
    // archivedCount should be 1 (tracked separately for the archived-sessions view).
    assert.equal(proj.sessions?.archivedCount ?? 0, 1, 'archivedCount should be 1');
  }
});

test('restore endpoint unmarks archived and session reappears as normal', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'archiverestore' });

    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'archiverestore', temp: true });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    await materializeJsonl(claudeProjectsRoot, inst);

    await api(baseUrl, 'DELETE', `/api/instances/${inst.id}`);
    await waitFor(() => !instances.get(inst.id));
    await waitFor(async () => (await isArchived(sid)));

    // Restore the session.
    const restoreRes = await api(baseUrl, 'POST', `/api/projects/archiverestore/sessions/${sid}/restore`);
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.body.ok, true);

    assert.equal(await isArchived(sid), false, 'session should no longer be archived');

    // list_sessions should return it with archived:false.
    const listRes = await api(baseUrl, 'GET', '/api/projects/archiverestore/sessions');
    const found = listRes.body.find(s => s.sessionId === sid);
    assert.ok(found, 'session should still exist after restore');
    assert.equal(found.archived, false, 'archived flag should be false after restore');
  }
});

test('killing a non-temp instance does NOT archive it', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'archivenotemp' });

    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'archivenotemp', temp: false });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    await materializeJsonl(claudeProjectsRoot, inst);

    await api(baseUrl, 'DELETE', `/api/instances/${inst.id}`);
    await waitFor(() => !instances.get(inst.id));

    // Give any async sidecar writes a moment to settle.
    await new Promise(r => setTimeout(r, 100));

    assert.equal(await isArchived(sid), false, 'non-temp session must NOT be archived on kill');
  }
});

test('MCP kill_instance archives temp session', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'archivemcp' });

    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'archivemcp', temp: true });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    const jsonlFile = await materializeJsonl(claudeProjectsRoot, inst);

    // Use the MCP kill_instance handler directly (same code path as the tool).
    const { killInstance } = await import('../src/mcp/handlers.js');
    await killInstance({ sessionId: inst.sessionId }, { instances });
    await waitFor(() => !instances.get(inst.id));

    // .jsonl must still exist.
    await fs.access(jsonlFile);
    await waitFor(async () => (await isArchived(sid)));
    assert.equal(await isArchived(sid), true);
  }
});

test('shutdownTempSync archives temp sessions — .jsonl kept, subagents dir removed', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'archivesync' });

    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'archivesync', temp: true });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;

    const dir = path.join(claudeProjectsRoot, encodeCwd(inst.cwd));
    await fs.mkdir(dir, { recursive: true });
    const jsonlFile = path.join(dir, `${sid}.jsonl`);
    const subagentsDir = path.join(dir, sid);
    await fs.writeFile(jsonlFile, '{"type":"user","uuid":"u1"}\n');
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.writeFile(path.join(subagentsDir, 'agent.jsonl'), '{}\n');

    instances.shutdownTempSync();

    // .jsonl must survive (we archive, not delete).
    await fs.access(jsonlFile);
    // Subagent dir is still cleaned up.
    await assert.rejects(() => fs.access(subagentsDir), 'subagent dir must be removed');
  }
});

test('sweepPendingTempCleanup keeps .jsonl and marks archived', async () => {
  {
    const cwd = '/tmp/cc-archive-sweep-' + Math.random().toString(36).slice(2);
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    const jsonlFile = path.join(dir, `${sid}.jsonl`);
    const subagentsDir = path.join(dir, sid);
    await fs.writeFile(jsonlFile, '{"type":"user","uuid":"u1"}\n');
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.writeFile(path.join(subagentsDir, 'a.jsonl'), '{}\n');

    await fs.mkdir(orchStoreRoot(), { recursive: true });
    writePendingTempCleanup([{ cwd, sessionId: sid }]);
    const manifest = pendingTempCleanupPath();
    await fs.access(manifest);
    // Atomic write: valid JSON, and no orphan tmp file left in the store dir.
    JSON.parse(await fs.readFile(manifest, 'utf8'));
    const residue = (await fs.readdir(orchStoreRoot())).filter(n => n.startsWith(path.basename(manifest) + '.tmp-'));
    assert.equal(residue.length, 0, 'no orphan .tmp- manifest file after atomic write');

    const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
    assert.equal(result.swept, 1);

    // .jsonl must survive.
    await fs.access(jsonlFile);
    // Subagent dir cleaned.
    await assert.rejects(() => fs.access(subagentsDir), 'subagent dir swept');
    // Manifest removed.
    await assert.rejects(() => fs.access(manifest), 'manifest removed after sweep');
  }
});

test('sweepPendingTempCleanup archives from a hand-written manifest with only entries', async () => {
  {
    const cwd = '/tmp/cc-legacy-sweep-' + Math.random().toString(36).slice(2);
    const sid = 'bbbbbbbb-cccc-dddd-eeee-000000000000';
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    const jsonlFile = path.join(dir, `${sid}.jsonl`);
    const subagentsDir = path.join(dir, sid);
    await fs.writeFile(jsonlFile, '{"type":"user","uuid":"u1"}\n');
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.writeFile(path.join(subagentsDir, 'a.jsonl'), '{}\n');

    await fs.mkdir(orchStoreRoot(), { recursive: true });
    const file = pendingTempCleanupPath();
    const payload = { writtenAt: new Date().toISOString(), entries: [{ cwd, sessionId: sid }] };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(payload));

    const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
    assert.equal(result.swept, 1);
    // Sweeping keeps the transcript, cleans the subagent dir, and marks archived.
    await fs.access(jsonlFile);
    await assert.rejects(() => fs.access(subagentsDir), 'subagent dir swept');
    await waitFor(async () => (await isArchived(sid)));
    assert.equal(await isArchived(sid), true);
  }
});

test('restore endpoint with missing .jsonl degrades gracefully (idempotent unmark)', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'archiveghost' });

    // Manually mark a session as archived without a .jsonl file.
    const { markArchived } = await import('../src/archivedSessions.js');
    const ghostSid = 'cccccccc-dddd-eeee-ffff-111111111111';
    await markArchived(ghostSid);
    assert.equal(await isArchived(ghostSid), true);

    // Restore should succeed even though the .jsonl doesn't exist.
    const restoreRes = await api(baseUrl, 'POST', `/api/projects/archiveghost/sessions/${ghostSid}/restore`);
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.body.ok, true);
    assert.equal(await isArchived(ghostSid), false);
  }
});
