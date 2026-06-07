import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the central store under a tmp PROJECTS_ROOT. projectsRoot()
// reads the env at call time, so setting it before importing is enough.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-temp-sessions-'));
process.env.PROJECTS_ROOT = path.join(tmp, 'project');

const { markTemp, unmarkTemp, isTemp, loadAllTemps } =
  await import('../src/tempSessions.js');

test('markTemp / isTemp / unmarkTemp round-trip + file shape', async () => {
  assert.equal(await isTemp('sid-1'), false, 'unknown sid is not temp');

  await markTemp('sid-1');
  await markTemp('sid-2');
  await markTemp('sid-1'); // idempotent — no duplicate
  assert.equal(await isTemp('sid-1'), true);
  assert.equal(await isTemp('sid-2'), true);
  assert.equal((await loadAllTemps()).size, 2);

  // File shape: { sessions: [...] } sorted, at <store>/temp-sessions.json.
  const file = path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'temp-sessions.json');
  const obj = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(obj.sessions, ['sid-1', 'sid-2']);

  await unmarkTemp('sid-1');
  assert.equal(await isTemp('sid-1'), false);
  assert.equal(await isTemp('sid-2'), true);

  // Emptying the set unlinks the file; loadAllTemps tolerates the ENOENT.
  await unmarkTemp('sid-2');
  assert.equal((await loadAllTemps()).size, 0);
  await assert.rejects(fs.access(file), 'file removed once the set empties');
});

test('loadAllTemps tolerates a malformed sidecar', async () => {
  const file = path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'temp-sessions.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'not json{');
  assert.equal((await loadAllTemps()).size, 0, 'garbage parses to an empty set, not a throw');
  await fs.rm(file, { force: true });
});
