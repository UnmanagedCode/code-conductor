import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd, orchStoreRoot } from '../src/projects.js';
import {
  pendingTempCleanupPath,
  writePendingTempCleanup,
  sweepPendingTempCleanup,
} from '../src/tempCleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// Bug repro: clicking "Restart server" used to leave temp-session jsonls on
// disk. The async `_handleExit` cleanup races process.exit(), so the temp
// jsonl + subagents dir survived the restart and reappeared in the sidebar
// as ordinary persistent sessions. `InstanceManager.shutdownTempSync()`
// performs the cleanup synchronously, and `scheduleRestart` calls it before
// exiting.

test('shutdownTempSync deletes temp jsonl + subagents dir and leaves non-temp alone', async () => {
  const { baseUrl, instances, claudeProjectsRoot, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    const created = await api(baseUrl, 'POST', '/api/projects', { name: 'restartcleanup' });
    assert.equal(created.status, 201);

    const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'restartcleanup', temp: true });
    assert.equal(tempRes.status, 201);
    const tempInst = instances.get(tempRes.body.id);
    await waitFor(() => tempInst.status === 'idle' && tempInst.sessionId);
    const tempSid = tempInst.sessionId;

    const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'restartcleanup' });
    assert.equal(normalRes.status, 201);
    const normalInst = instances.get(normalRes.body.id);
    await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId);
    const normalSid = normalInst.sessionId;

    // Materialize both jsonls (fake-claude doesn't write to ~/.claude/projects).
    const dir = path.join(claudeProjectsRoot, encodeCwd(tempInst.cwd));
    await fs.mkdir(dir, { recursive: true });
    const tempJsonl = path.join(dir, `${tempSid}.jsonl`);
    const tempSubagents = path.join(dir, tempSid);
    const normalJsonl = path.join(dir, `${normalSid}.jsonl`);
    await fs.writeFile(tempJsonl, '{"type":"user","uuid":"u1"}\n');
    await fs.mkdir(tempSubagents, { recursive: true });
    await fs.writeFile(path.join(tempSubagents, 'agent.jsonl'), '{}\n');
    await fs.writeFile(normalJsonl, '{"type":"user","uuid":"u2"}\n');

    instances.shutdownTempSync();

    await assert.rejects(() => fs.access(tempJsonl), 'temp jsonl must be deleted');
    await assert.rejects(() => fs.access(tempSubagents), 'temp subagents dir must be deleted');
    await fs.access(normalJsonl); // non-temp jsonl untouched
  } finally { await close(); }
});

test('tempCleanupSnapshot only includes live temp instances with a sessionId', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'snapshotproj' });
    const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'snapshotproj', temp: true });
    const tempInst = instances.get(tempRes.body.id);
    await waitFor(() => tempInst.sessionId);
    const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'snapshotproj' });
    const normalInst = instances.get(normalRes.body.id);
    await waitFor(() => normalInst.sessionId);

    const snap = instances.tempCleanupSnapshot();
    assert.equal(snap.length, 1);
    assert.deepEqual(snap[0], { cwd: tempInst.cwd, sessionId: tempInst.sessionId });
  } finally { await close(); }
});

test('writePendingTempCleanup + sweepPendingTempCleanup round-trip deletes listed jsonls', async () => {
  const { instances, claudeProjectsRoot, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    const cwd = '/tmp/cc-fake-cwd-' + Math.random().toString(36).slice(2);
    const sid = '11111111-2222-3333-4444-555555555555';
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    const jsonl = path.join(dir, `${sid}.jsonl`);
    const subagents = path.join(dir, sid);
    await fs.writeFile(jsonl, '{"type":"user","uuid":"u1"}\n');
    await fs.mkdir(subagents, { recursive: true });
    await fs.writeFile(path.join(subagents, 'a.jsonl'), '{}\n');

    // Manifest dir must exist (orchStoreRoot lives under projectsRoot).
    await fs.mkdir(orchStoreRoot(), { recursive: true });
    writePendingTempCleanup([{ cwd, sessionId: sid }]);

    const manifest = pendingTempCleanupPath();
    await fs.access(manifest);

    const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
    assert.equal(result.swept, 1);
    await assert.rejects(() => fs.access(jsonl));
    await assert.rejects(() => fs.access(subagents));
    await assert.rejects(() => fs.access(manifest));

    void instances;
  } finally { await close(); }
});

test('sweepPendingTempCleanup re-deletes files that reappeared after the manifest was written', async () => {
  // Simulates the bug: claude (or an orphaned subagent) wrote to the jsonl
  // AFTER our parent process called shutdownTempSync and exited. The post-
  // restart boot sweep must wipe it again.
  const { claudeProjectsRoot, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    const cwd = '/tmp/cc-orphaned-' + Math.random().toString(36).slice(2);
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));

    // Manifest written; no files on disk yet (shutdownTempSync deleted them).
    await fs.mkdir(orchStoreRoot(), { recursive: true });
    writePendingTempCleanup([{ cwd, sessionId: sid }]);

    // Orphaned write reappears.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"late"}\n');
    await fs.mkdir(path.join(dir, sid), { recursive: true });

    const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
    assert.equal(result.swept, 1);
    await assert.rejects(() => fs.access(path.join(dir, `${sid}.jsonl`)));
    await assert.rejects(() => fs.access(path.join(dir, sid)));
    await assert.rejects(() => fs.access(pendingTempCleanupPath()));
  } finally { await close(); }
});

test('sweepPendingTempCleanup is a safe no-op when no manifest exists', async () => {
  const { close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
    assert.equal(result.swept, 0);
  } finally { await close(); }
});

test('shutdownTempSync is a safe no-op when there are no temp instances', async () => {
  const { baseUrl, instances, claudeProjectsRoot, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'restartcleanup2' });
    const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'restartcleanup2' });
    const normalInst = instances.get(normalRes.body.id);
    await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId);

    const dir = path.join(claudeProjectsRoot, encodeCwd(normalInst.cwd));
    await fs.mkdir(dir, { recursive: true });
    const jsonl = path.join(dir, `${normalInst.sessionId}.jsonl`);
    await fs.writeFile(jsonl, '{"type":"user","uuid":"u1"}\n');

    assert.doesNotThrow(() => instances.shutdownTempSync());
    await fs.access(jsonl);
  } finally { await close(); }
});
