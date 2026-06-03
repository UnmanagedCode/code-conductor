import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the central store under a tmp PROJECTS_ROOT. projectsRoot()
// reads the env at call time, so setting it before importing is enough.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-conductor-'));
process.env.PROJECTS_ROOT = path.join(tmp, 'project');

const { markConductor, unmarkConductor, isConductor, loadAll } =
  await import('../src/conductorSessions.js');

test('markConductor / isConductor / unmarkConductor round-trip + file shape', async () => {
  assert.equal(await isConductor('sid-1'), false, 'unknown sid is not conductor');

  await markConductor('sid-1');
  await markConductor('sid-2');
  await markConductor('sid-1'); // idempotent — no duplicate
  assert.equal(await isConductor('sid-1'), true);
  assert.equal(await isConductor('sid-2'), true);
  assert.equal((await loadAll()).size, 2);

  // File shape: { sessions: [...] } sorted, at <store>/conductor-sessions.json.
  const file = path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'conductor-sessions.json');
  const obj = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(obj.sessions, ['sid-1', 'sid-2']);

  await unmarkConductor('sid-1');
  assert.equal(await isConductor('sid-1'), false);
  assert.equal(await isConductor('sid-2'), true);

  // Emptying the set unlinks the file; loadAll tolerates the ENOENT.
  await unmarkConductor('sid-2');
  assert.equal((await loadAll()).size, 0);
  await assert.rejects(fs.access(file), 'file removed once the set empties');
});

test('loadAll tolerates a malformed sidecar', async () => {
  const file = path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'conductor-sessions.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'not json{');
  assert.equal((await loadAll()).size, 0, 'garbage parses to an empty set, not a throw');
  await fs.rm(file, { force: true });
});
