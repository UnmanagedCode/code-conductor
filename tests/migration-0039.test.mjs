// Migration 0039: the eight per-session sidecar stores merge into one
// `<store>/sessions.json` keyed by public id, and the legacy files move to
// `<store>/migrated-backup-0039/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as m0039 from '../migrations/0039-unified-session-store.mjs';
import { runMigrations } from '../migrations/index.mjs';

const PUB = 'a1b2c3d4';
const SEG1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const SEG2 = 'e5f6a7b8-0000-4000-8000-000000000002';
const LONE = 'c0ffee00-0000-4000-8000-000000000003';

async function mkRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-m0039-'));
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  return root;
}
const store = (root) => path.join(root, '.code-conductor');
const file = (root, name) => path.join(store(root), name);
const writeJson = (root, name, obj) => fs.writeFile(file(root, name), JSON.stringify(obj, null, 2) + '\n');
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const exists = (p) => fs.access(p).then(() => true, () => false);
const run = (root, log = () => {}) => m0039.run({ root, log });

// A two-segment lineage row plus facts spread over both backing ids.
async function seedLegacy(root) {
  await writeJson(root, 'session-lineage.json', { sessions: { [PUB]: { current: SEG2, segments: [
    { id: SEG1, reason: 'initial', at: '2026-09-01T00:00:00Z' },
    { id: SEG2, reason: 'renew', at: '2026-09-02T00:00:00Z' },
  ] } } });
  await writeJson(root, 'session-titles.json', { titles: { [SEG1]: 'old title', [SEG2]: 'new title', [LONE]: 'lone' } });
  await writeJson(root, 'session-modes.json', { sessions: { [SEG1]: 'plan' } });
  await writeJson(root, 'session-backends.json', { sessions: {
    [SEG2]: { backend: 'ollama', model: 'deepseek-v4-flash:cloud', contextWindowTokens: 131072 },
  } });
  await writeJson(root, 'conducted-sessions.json', { sessions: [SEG1] });
  await writeJson(root, 'temp-sessions.json', { sessions: [SEG2] });
  await writeJson(root, 'archived-sessions.json', { sessions: [SEG1, LONE] });
}

test('an empty store is a no-op', async () => {
  const root = await mkRoot();
  assert.deepEqual(await run(root), { applied: false });
  assert.equal(await exists(file(root, 'sessions.json')), false);
});

test('(a) a lineage row takes the newest segment\'s facts; temp/archived land per segment', async () => {
  const root = await mkRoot();
  await seedLegacy(root);
  const res = await run(root);
  assert.equal(res.applied, true);
  const rec = (await readJson(file(root, 'sessions.json'))).sessions[PUB];
  assert.equal(rec.current, SEG2);
  assert.equal(rec.title, 'new title', 'the newest segment\'s title wins');
  assert.equal(rec.mode, 'plan', 'an older segment fills a fact no newer segment has');
  assert.deepEqual(rec.backend, { backend: 'ollama', model: 'deepseek-v4-flash:cloud', contextWindowTokens: 131072 });
  assert.equal(rec.conducted, true);
  assert.deepEqual(rec.segments.map(s => [s.id, s.reason, s.temp ?? false, s.archived ?? false]),
    [[SEG1, 'initial', false, true], [SEG2, 'renew', true, false]]);
});

test('(b) a backing id lineage does not know becomes its own base-case record', async () => {
  const root = await mkRoot();
  await seedLegacy(root);
  const res = await run(root);
  const rec = (await readJson(file(root, 'sessions.json'))).sessions[LONE];
  assert.equal(rec.current, LONE);
  assert.deepEqual(rec.segments.map(s => [s.id, s.reason, s.archived]), [[LONE, 'initial', true]]);
  assert.equal(rec.title, 'lone');
  assert.equal(res.summary.created, 1);
});

test('(c) summaries keyed by the public id and by a segment merge by generatedAt', async () => {
  const root = await mkRoot();
  await seedLegacy(root);
  await writeJson(root, 'session-summaries.json', { summaries: {
    [PUB]: { short: { summary: 'pub short', generatedAt: 10, messageCount: 1 },
             long: { summary: 'pub long', generatedAt: 50, messageCount: 5 } },
    [SEG1]: { short: { summary: 'seg short', generatedAt: 20, messageCount: 2 },
              long: { summary: 'seg long', generatedAt: 5, messageCount: 1 } },
  } });
  await run(root);
  const { summaries } = (await readJson(file(root, 'sessions.json'))).sessions[PUB];
  assert.equal(summaries.short.summary, 'seg short', 'the later generatedAt wins per tier');
  assert.equal(summaries.long.summary, 'pub long');
});

test('(d) a minted-shaped key with no session is counted unattributable', async () => {
  const root = await mkRoot();
  await writeJson(root, 'session-titles.json', { titles: { deadbeef: 'orphan' } });
  const logs = [];
  const res = await run(root, (m) => logs.push(m));
  assert.equal(res.summary.unattributable, 1);
  assert.deepEqual((await readJson(file(root, 'sessions.json'))).sessions, {}, 'no phantom record');
  assert.ok(logs.some(l => l.includes('deadbeef')), JSON.stringify(logs));
  assert.equal(await exists(file(root, 'migrated-backup-0039/session-titles.json')), true,
    'its value survives in the backup dir');
});

test('(e) legacy files move to the backup dir and a second run is a no-op', async () => {
  const root = await mkRoot();
  await seedLegacy(root);
  await fs.writeFile(file(root, 'archived-sessions.json.bak'), JSON.stringify({ sessions: [SEG1] }));
  await fs.writeFile(file(root, 'temp-sessions.json.lock'), '{}');
  await run(root);
  for (const name of ['session-lineage.json', 'session-titles.json', 'session-modes.json',
    'session-backends.json', 'conducted-sessions.json', 'temp-sessions.json',
    'archived-sessions.json', 'archived-sessions.json.bak']) {
    assert.equal(await exists(file(root, name)), false, `${name} moved out of the store`);
    assert.equal(await exists(file(root, `migrated-backup-0039/${name}`)), true, `${name} is in the backup dir`);
  }
  assert.equal(await exists(file(root, 'temp-sessions.json.lock')), true, 'lock files are left alone');
  assert.deepEqual(await run(root), { applied: false });
});

test('(f) a recreated legacy file re-merges additively without clobbering a sessions.json fact', async () => {
  const root = await mkRoot();
  await seedLegacy(root);
  await run(root);
  // An exiting old server writes after the merge.
  await writeJson(root, 'session-titles.json', { titles: { [SEG2]: 'stale title' } });
  await writeJson(root, 'session-modes.json', { sessions: { [LONE]: 'plan' } });
  const res = await run(root);
  assert.equal(res.applied, true);
  const { sessions } = await readJson(file(root, 'sessions.json'));
  assert.equal(sessions[PUB].title, 'new title', 'the merged store\'s fact wins');
  assert.equal(sessions[LONE].mode, 'plan', 'a gap is filled');
  const backups = await fs.readdir(file(root, 'migrated-backup-0039'));
  assert.equal(backups.filter(n => n.startsWith('session-titles.json')).length, 2,
    'the second copy is kept beside the first under a suffixed name');
});

test('a legacy lineage row AHEAD of the merged record appends its segments and advances current', async () => {
  const root = await mkRoot();
  // The merged store, as a previous run left it: PUB on SEG1 alone.
  await writeJson(root, 'sessions.json', { sessions: {
    [PUB]: { current: SEG1, segments: [{ id: SEG1, reason: 'initial', at: '2026-09-01T00:00:00Z' }], title: 'kept' },
  } });
  // An old-version process rotated PUB onto SEG2 after that merge.
  await writeJson(root, 'session-lineage.json', { sessions: { [PUB]: { current: SEG2, segments: [
    { id: SEG1, reason: 'initial', at: '2026-09-01T00:00:00Z' },
    { id: SEG2, reason: 'renew', at: '2026-09-02T00:00:00Z' },
  ] } } });
  await writeJson(root, 'temp-sessions.json', { sessions: [SEG2] });
  const res = await run(root);
  const { sessions } = await readJson(file(root, 'sessions.json'));
  assert.equal(sessions[PUB].current, SEG2, 'current follows the newer chain');
  assert.deepEqual(sessions[PUB].segments.map(s => [s.id, s.reason]), [[SEG1, 'initial'], [SEG2, 'renew']]);
  assert.equal(sessions[SEG2], undefined, 'the post-rotation transcript is not forked into its own record');
  assert.equal(sessions[PUB].segments[1].temp, true, 'a flag lands on the segment new to the base');
  assert.equal(sessions[PUB].title, 'kept');
  assert.equal(res.summary.advanced, 1);
});

test('a legacy lineage row that adds nothing leaves the merged record alone', async () => {
  const root = await mkRoot();
  const merged = { current: SEG2, segments: [
    { id: SEG1, reason: 'initial', at: '2026-09-01T00:00:00Z' },
    { id: SEG2, reason: 'renew', at: '2026-09-02T00:00:00Z' },
  ] };
  await writeJson(root, 'sessions.json', { sessions: { [PUB]: merged } });
  await writeJson(root, 'session-lineage.json', { sessions: { [PUB]: { current: SEG1, segments: [merged.segments[0]] } } });
  const res = await run(root);
  assert.deepEqual((await readJson(file(root, 'sessions.json'))).sessions[PUB], merged);
  assert.equal(res.summary.advanced, 0);
});

test('a stale legacy flag never re-applies to a segment the merged store already owns', async () => {
  const root = await mkRoot();
  // The user restored SEG1 after the merge; an old server's archived file still lists it.
  await writeJson(root, 'sessions.json', { sessions: {
    [SEG1]: { current: SEG1, segments: [{ id: SEG1, reason: 'initial', at: '' }] },
  } });
  await writeJson(root, 'archived-sessions.json', { sessions: [SEG1] });
  await writeJson(root, 'temp-sessions.json', { sessions: [SEG1] });
  await run(root);
  const seg = (await readJson(file(root, 'sessions.json'))).sessions[SEG1].segments[0];
  assert.equal(seg.archived, undefined, 'the restored segment stays restored');
  assert.equal(seg.temp, undefined);
});

test('the merge seeds sessions.json.bak with the written doc', async () => {
  const root = await mkRoot();
  await seedLegacy(root);
  await run(root);
  assert.deepEqual(await readJson(file(root, 'sessions.json.bak')), await readJson(file(root, 'sessions.json')));
});

test('a record whose segments all fail validation is dropped and counted', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', { sessions: {
    [SEG1]: { current: SEG1, segments: [{ id: SEG1, reason: 'initial', at: '' }] },
    broken: { current: 'x', segments: [{ id: 'x', reason: 'not-a-reason' }] },
  } });
  await writeJson(root, 'session-lineage.json', { sessions: {
    [PUB]: { current: SEG2, segments: [{ id: SEG2, reason: 'bogus' }] },
  } });
  const res = await run(root);
  assert.deepEqual(Object.keys((await readJson(file(root, 'sessions.json'))).sessions), [SEG1]);
  assert.equal(res.summary.invalid, 2, 'one base record and one legacy row');
});

test('(g) an absent archived primary falls back to its .bak', async () => {
  const root = await mkRoot();
  await fs.writeFile(file(root, 'archived-sessions.json.bak'), JSON.stringify({ sessions: [LONE] }));
  await run(root);
  const rec = (await readJson(file(root, 'sessions.json'))).sessions[LONE];
  assert.equal(rec.segments[0].archived, true);
});

test('an unparseable sessions.json aborts the merge', async () => {
  const root = await mkRoot();
  await seedLegacy(root);
  await fs.writeFile(file(root, 'sessions.json'), '{ "sessions": ');
  await assert.rejects(run(root), /unparseable/);
  assert.equal(await exists(file(root, 'session-titles.json')), true, 'nothing moved');
});

test('after the merge, the whole chain over the store is silent', async () => {
  // The older migrations that name the legacy files (0005, 0008, 0018, 0018b,
  // 0026) must no-op once 0039 has moved them away.
  const root = await mkRoot();
  await seedLegacy(root);
  await runMigrations({ root, log: () => {} });
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
});
