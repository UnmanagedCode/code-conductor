// A typed `/clear` rotates the CLI's backing id with NO managed renew armed, so
// nothing but the production `system/init` rotation branch runs for it. These
// tests pin what that rotation must leave behind: session-level facts (title,
// backend) stay on the session, the pre-clear transcript is archived, and the
// new transcript inherits the temp flag — the same outcome a managed renew has.
//
// `rotate` (tests/segmentChain.mjs) drives the real rotation branch; the fake
// engine writes no jsonl, so each test seeds the transcripts a resume needs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, seedSessionJsonl } from './helpers.mjs';
import { rotate } from './segmentChain.mjs';
import { localPlace, listSessionsForCwdWithCounts, orchStoreRoot } from '../src/projects.ts';
import { recordRotation, revertRotation, resolveBacking, dropSegment } from '../src/sessionLineage.ts';
import { getTitle, setTitle, isTemp, loadSessions } from '../src/sessionStore.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

async function spawn(body) {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst;
}

// Rotate `inst` as a typed `/clear` would, with both transcripts on disk so the
// session stays resumable and listable afterwards.
async function typedClear(inst, records) {
  const place = localPlace(path.join(projectsRoot, 'p'));
  const oldBacking = inst.backingSessionId;
  const newBacking = randomUUID();
  await seedSessionJsonl(place, oldBacking);
  await seedSessionJsonl(place, newBacking, records);
  await rotate(inst, newBacking);
  assert.equal(inst.backingSessionId, newBacking, 'precondition: the rotation branch ran');
  return { place, oldBacking, newBacking };
}

async function resumeByPublicId(publicId, extra = {}) {
  const inst = await instances.create({ project: 'p', resume: publicId, ...extra });
  await waitFor(() => inst.status === 'idle');
  return inst;
}

// Any store file under <store> carrying `needle`: the spawn-time backend write is
// fire-and-forget, so the test waits for it to land without naming the file.
async function storeMentions(needle) {
  let names;
  try { names = await fs.readdir(orchStoreRoot()); } catch { return false; }
  for (const n of names.filter(n => n.endsWith('.json'))) {
    const text = await fs.readFile(path.join(orchStoreRoot(), n), 'utf8').catch(() => '');
    if (text.includes(needle)) return true;
  }
  return false;
}

test('a typed /clear keeps the custom title on the session', async () => {
  const inst = await spawn({});
  const publicId = inst.sessionId;
  const TITLE = 'Survives a typed clear';
  const put = await api(baseUrl, 'PUT', `/api/sessions/${publicId}/title`, { title: TITLE });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const { place, newBacking } = await typedClear(inst);
  await instances.remove(inst.id);

  const resumed = await resumeByPublicId(publicId);
  assert.equal(resumed.backingSessionId, newBacking, 'precondition: the resume opened the post-clear transcript');
  await waitFor(() => resumed.title === TITLE, { timeout: 2000 }).catch(() => {});
  assert.equal(resumed.title, TITLE, 'the resumed session must carry the title set before the clear');

  const { rows } = await listSessionsForCwdWithCounts(place);
  const row = rows.find(r => r.sessionId === publicId);
  assert.ok(row, `the post-clear transcript lists under the public id: ${JSON.stringify(rows)}`);
  assert.equal(row.title, TITLE, 'the listing row must show the title set before the clear');
});

test('a typed /clear keeps a substitution backend and exact model on resume', async () => {
  const MODEL = 'deepseek-v4-flash:cloud';
  const inst = await spawn({ backend: 'ollama', model: MODEL });
  const publicId = inst.sessionId;
  await waitFor(() => storeMentions(MODEL));

  // The CLI records the model lossily (tag dropped): that is all the jsonl has.
  await typedClear(inst, [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', model: 'deepseek-v4-flash', content: [] } },
  ]);
  await instances.remove(inst.id);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'typed-clear-backend-'));
  const argvDump = path.join(tmp, 'argv.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  try {
    const resumed = await resumeByPublicId(publicId); // no explicit backend or model
    assert.equal(resumed.backend, 'ollama', 'the resume must come back on the backend the session ran on');
    assert.equal(resumed.model, MODEL, 'the resume must carry the exact tagged model, not the jsonl report');
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    assert.deepEqual(argv.slice(0, 6), ['launch', 'claude', '--model', MODEL, '--yes', '--'],
      'the resume relaunches through the backend template with the tagged model');
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test('a typed /clear archives the pre-clear segment and carries temp to the new one', async () => {
  const inst = await spawn({ temp: true });
  const { place, oldBacking, newBacking } = await typedClear(inst);

  const { rows } = await listSessionsForCwdWithCounts(place);
  const oldRow = rows.find(r => r.sessionId === oldBacking);
  const newRow = rows.find(r => r.sessionId === inst.sessionId);
  assert.ok(oldRow && newRow, `both transcripts list: ${JSON.stringify(rows)}`);
  assert.equal(oldRow.archived, true, 'the pre-clear transcript is archived by the rotation');
  assert.equal(oldRow.temp, false, 'the pre-clear transcript drops its temp flag');
  assert.equal(newRow.archived, false, 'the post-clear transcript stays live');
  assert.equal(newRow.temp, true, 'the post-clear transcript inherits the temp flag');
  assert.notEqual(oldBacking, newBacking);
});

test('prune rollback keeps a pre-lineage session\'s facts', async () => {
  // A base-case session (never minted, never rotated) carrying a fact.
  const sid = randomUUID();
  const pruned = randomUUID();
  await setTitle(sid, 'kept');
  await recordRotation(sid, pruned, 'prune');
  await revertRotation(sid, pruned);
  assert.equal(await getTitle(sid), 'kept', 'the rollback must not delete the record holding the title');
  assert.equal(await resolveBacking(sid), sid, 'the rolled-back session resolves as the base case');
  assert.deepEqual((await loadSessions()).byPublic.get(sid).segments.map(s => s.id), [sid]);
});

test('loadHistory ENOENT never deletes the last live segment\'s record', async () => {
  const inst = await spawn({ temp: true });
  const TITLE = 'killed before its first turn';
  await api(baseUrl, 'PUT', `/api/sessions/${inst.sessionId}/title`, { title: TITLE });
  await waitFor(() => isTemp(inst.backingSessionId));
  // The fake engine wrote no transcript: the replay finds none.
  await inst.loadHistory(inst.backingSessionId);
  await inst.flushLineage();
  const rec = (await loadSessions()).byPublic.get(inst.sessionId);
  assert.ok(rec, 'the record survives');
  assert.equal(rec.title, TITLE);
  assert.equal(rec.segments.length, 1);
  assert.notEqual(rec.segments[0].dropped, true, 'its only segment is not tombstoned');
  assert.equal(await isTemp(inst.backingSessionId), true, 'the temp flag survives');

  // Not the last: a missing older segment IS tombstoned.
  const newer = randomUUID();
  await recordRotation(inst.sessionId, newer, 'renew');
  await dropSegment(inst.backingSessionId, { unlessLast: true });
  const after = (await loadSessions()).byPublic.get(inst.sessionId);
  assert.equal(after.segments[0].dropped, true, 'a non-last missing segment is tombstoned');
  assert.equal(after.current, newer);
});
