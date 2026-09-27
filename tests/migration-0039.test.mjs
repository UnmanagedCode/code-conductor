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
  assert.equal(res.summary.skipped, 1, 'the row that placed nothing is counted');
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

const baseRec = (id, extra = {}) => ({ current: id, segments: [{ id, reason: 'initial', at: '' }], ...extra });
const R1 = '11111111-0000-4000-8000-000000000001';
const R2 = '22222222-0000-4000-8000-000000000002';
const R3 = '33333333-0000-4000-8000-000000000003';

test('a missing primary merges onto its .bak, and both keep every record', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json.bak', { sessions: { [R1]: baseRec(R1), [R2]: baseRec(R2), [R3]: baseRec(R3) } });
  await writeJson(root, 'session-titles.json', { titles: { [LONE]: 'lone' } });
  await run(root);
  const all = [R1, R2, R3, LONE].sort();
  assert.deepEqual(Object.keys((await readJson(file(root, 'sessions.json'))).sessions).sort(), all,
    'the base is the backup, not an empty store');
  assert.deepEqual(Object.keys((await readJson(file(root, 'sessions.json.bak'))).sessions).sort(), all);
});

test('a thin primary never overwrites a .bak holding records it lacks', async (t) => {
  // One subtest per size, so the boundary (1 and 2 records) is each its own red.
  for (const n of [1, 2, 3]) {
    await t.test(`.bak with ${n} record(s)`, async () => {
      const root = await mkRoot();
      await writeJson(root, 'sessions.json', { sessions: {} });
      const bak = { sessions: Object.fromEntries([R1, R2, R3].slice(0, n).map(id => [id, baseRec(id)])) };
      await writeJson(root, 'sessions.json.bak', bak);
      await writeJson(root, 'session-titles.json', { titles: { [LONE]: 'lone' } });
      await run(root);
      assert.deepEqual(Object.keys((await readJson(file(root, 'sessions.json'))).sessions), [LONE]);
      assert.deepEqual(await readJson(file(root, 'sessions.json.bak')), bak, 'the last-good backup survives');
    });
  }
});

test('a .bak record the store cannot read does not hold back the refresh', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', { sessions: { [R1]: baseRec(R1) } });
  await writeJson(root, 'sessions.json.bak', { sessions: {
    [R1]: baseRec(R1), broken: { current: 'x', segments: [{ id: 'x', reason: 'bogus' }] },
  } });
  await writeJson(root, 'session-titles.json', { titles: { [LONE]: 'lone' } });
  await run(root);
  assert.deepEqual(Object.keys((await readJson(file(root, 'sessions.json.bak'))).sessions).sort(), [R1, LONE].sort());
});

test('a corrupt .bak is replaced by the merged doc', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', { sessions: { [R1]: baseRec(R1) } });
  await fs.writeFile(file(root, 'sessions.json.bak'), '{ "sessions": ');
  await writeJson(root, 'session-titles.json', { titles: { [LONE]: 'lone' } });
  await run(root);
  assert.deepEqual(await readJson(file(root, 'sessions.json.bak')), await readJson(file(root, 'sessions.json')));
});

// Every segment id → the records holding it.
function owners(sessions) {
  const out = new Map();
  for (const [pub, rec] of Object.entries(sessions)) {
    for (const seg of rec.segments) out.set(seg.id, [...(out.get(seg.id) ?? []), pub]);
  }
  return out;
}

test('a base-owned segment named by another record\'s legacy row stays in one record', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', { sessions: { [R1]: baseRec(R1), [R2]: baseRec(R2) } });
  // R2's stale legacy row also names R1's segment, plus one of its own.
  await writeJson(root, 'session-lineage.json', { sessions: { [R2]: { current: R3, segments: [
    { id: R2, reason: 'initial', at: '' }, { id: R1, reason: 'renew', at: '' }, { id: R3, reason: 'renew', at: '' },
  ] } } });
  await run(root);
  const { sessions } = await readJson(file(root, 'sessions.json'));
  for (const [id, pubs] of owners(sessions)) assert.equal(pubs.length, 1, `${id} is in ${pubs.join(', ')}`);
  assert.deepEqual(owners(sessions).get(R1), [R1]);
  assert.deepEqual(sessions[R2].segments.map(s => s.id), [R2, R3], 'only the unclaimed segment is appended');
});

test('two legacy rows naming one segment leave it in one record', async () => {
  const root = await mkRoot();
  await writeJson(root, 'session-lineage.json', { sessions: {
    aaaaaaaa: { current: R1, segments: [{ id: R1, reason: 'initial', at: '' }] },
    bbbbbbbb: { current: R1, segments: [{ id: R2, reason: 'initial', at: '' }, { id: R1, reason: 'renew', at: '' }] },
  } });
  await run(root);
  const { sessions } = await readJson(file(root, 'sessions.json'));
  for (const [id, pubs] of owners(sessions)) assert.equal(pubs.length, 1, `${id} is in ${pubs.join(', ')}`);
  assert.equal(sessions.bbbbbbbb.current, R2, 'current falls to a live segment the record actually holds');
});

test('a segment appended to an existing record is not taken by a later row', async () => {
  const S = '44444444-0000-4000-8000-000000000004';
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', { sessions: { [R1]: baseRec(R1), [R2]: baseRec(R2) } });
  await writeJson(root, 'session-lineage.json', { sessions: {
    [R1]: { current: S, segments: [{ id: R1, reason: 'initial', at: '' }, { id: S, reason: 'renew', at: '' }] },
    [R2]: { current: S, segments: [{ id: R2, reason: 'initial', at: '' }, { id: S, reason: 'renew', at: '' }] },
  } });
  const res = await run(root);
  const { sessions } = await readJson(file(root, 'sessions.json'));
  assert.deepEqual(owners(sessions).get(S), [R1], 'the first row to place it owns it');
  assert.deepEqual(sessions[R2].segments.map(s => s.id), [R2]);
  assert.equal(res.summary.skipped, 1);
});

test('a new record whose legacy current is claimed falls back to its newest kept live segment', async () => {
  const [A, B, C] = [R1, R2, R3];
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', { sessions: { [C]: baseRec(C) } });
  await writeJson(root, 'session-lineage.json', { sessions: { cccccccc: { current: C, segments: [
    { id: A, reason: 'initial', at: '' }, { id: B, reason: 'renew', at: '' }, { id: C, reason: 'renew', at: '' },
  ] } } });
  await run(root);
  const rec = (await readJson(file(root, 'sessions.json'))).sessions.cccccccc;
  assert.deepEqual(rec.segments.map(s => s.id), [A, B]);
  assert.equal(rec.current, B, 'the newest kept live segment, not the oldest');
});

test('an appended row never advances current onto a tombstoned segment', async () => {
  const T = '55555555-0000-4000-8000-000000000005';
  const U = '66666666-0000-4000-8000-000000000006';
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', { sessions: { [R1]: { current: R1, segments: [
    { id: R1, reason: 'initial', at: '' }, { id: T, reason: 'renew', at: '', dropped: true },
  ] } } });
  // A stale row from before T's transcript was deleted names it as current.
  await writeJson(root, 'session-lineage.json', { sessions: { [R1]: { current: T, segments: [
    { id: R1, reason: 'initial', at: '' }, { id: T, reason: 'renew', at: '' }, { id: U, reason: 'renew', at: '' },
  ] } } });
  await run(root);
  const rec = (await readJson(file(root, 'sessions.json'))).sessions[R1];
  assert.equal(rec.current, R1, 'current stays on a live segment');
  assert.notEqual(rec.segments.find(s => s.id === rec.current)?.dropped, true);
});

test('a new-record row with only tombstones unclaimed is skipped, not written', async () => {
  const D = '77777777-0000-4000-8000-000000000007';
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', { sessions: { [R1]: baseRec(R1) } });
  await writeJson(root, 'session-lineage.json', { sessions: { dddddddd: { current: R1, segments: [
    { id: D, reason: 'initial', at: '', dropped: true }, { id: R1, reason: 'renew', at: '' },
  ] } } });
  const res = await run(root);
  assert.equal((await readJson(file(root, 'sessions.json'))).sessions.dddddddd, undefined, 'no tombstone-only record');
  assert.equal(res.summary.skipped, 1);
});

test('(g) an absent archived primary falls back to its .bak', async () => {
  const root = await mkRoot();
  await fs.writeFile(file(root, 'archived-sessions.json.bak'), JSON.stringify({ sessions: [LONE] }));
  await run(root);
  const rec = (await readJson(file(root, 'sessions.json'))).sessions[LONE];
  assert.equal(rec.segments[0].archived, true);
});

test('an unparseable sessions.json is quarantined and the merge lands on its .bak', async () => {
  const root = await mkRoot();
  await seedLegacy(root);
  const corrupt = '{ "sessions": ';
  await fs.writeFile(file(root, 'sessions.json'), corrupt);
  await writeJson(root, 'sessions.json.bak', { sessions: { [R1]: baseRec(R1) } });
  const res = await run(root);
  assert.equal(res.applied, true, 'boot is not aborted');
  const quarantined = (await fs.readdir(store(root))).filter(n => n.startsWith('sessions.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'the corrupt primary is set aside');
  assert.equal(await fs.readFile(file(root, quarantined[0]), 'utf8'), corrupt, 'byte-for-byte');
  const { sessions } = await readJson(file(root, 'sessions.json'));
  assert.ok(sessions[R1], 'the .bak record is the base');
  assert.equal(sessions[PUB].title, 'new title', 'and the legacy merge lands on it');
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
