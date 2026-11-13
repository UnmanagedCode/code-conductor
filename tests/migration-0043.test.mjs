// Migration 0043: the session store records `persistent` on the sessions that
// stay listed instead of `temp` on the ones archived on exit; the restore files'
// entries follow, and the boot archive list takes its new name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as m0043 from '../migrations/0043-persistent-sessions.mjs';
import { runMigrations } from '../migrations/index.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

// Migration 0004 moves $HOME/.code-conductor/{whisper.cpp,piper} into the migrated root;
// this file runs the whole chain, so HOME is a registry dir it owns, never the real one.
process.env.HOME = await mkdtemp('cc-mig43-home-');

async function mkRoot() {
  const root = await mkdtemp('cc-m0043-');
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  return root;
}
const store = (root) => path.join(root, '.code-conductor');
const file = (root, name) => path.join(store(root), name);
const writeJson = (root, name, obj) => fs.writeFile(file(root, name), JSON.stringify(obj, null, 2) + '\n');
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const exists = (p) => fs.access(p).then(() => true, () => false);
const run = (root, log = () => {}) => m0043.run({ root, log });

const seg = (id, reason, extra = {}) => ({ id, reason, at: '2026-09-01T00:00:00Z', ...extra });

// A: a normal session (current temp) with an archived renew predecessor.
// B: a persistent session (current live, unflagged) with an archived predecessor and a tombstone.
// C: an exited normal session (current archived).
// D: current temp plus a leftover live unflagged non-current segment.
// E: a segment whose temp is malformed.
// F: a record carrying every other session fact, plus an unknown key.
function fixture() {
  return { sessions: {
    aaaaaaaa: { current: 'a2', segments: [seg('a1', 'initial', { archived: true }), seg('a2', 'renew', { temp: true })] },
    bbbbbbbb: { current: 'b3', segments: [
      seg('b1', 'initial', { archived: true }), seg('b2', 'prune', { dropped: true }), seg('b3', 'renew'),
    ] },
    cccccccc: { current: 'c1', segments: [seg('c1', 'initial', { archived: true })] },
    dddddddd: { current: 'd2', segments: [seg('d1', 'initial'), seg('d2', 'renew', { temp: true })] },
    eeeeeeee: { current: 'e1', segments: [seg('e1', 'initial', { temp: 'yes' })] },
    ffffffff: {
      current: 'f1', segments: [seg('f1', 'initial')],
      title: 'kept', mode: 'plan', backend: { backend: 'claude', model: 'm', contextWindowTokens: 200000 },
      summaries: { short: { summary: 's', generatedAt: 1, messageCount: 2 } }, conducted: true,
      modelSwitches: [{ id: 'x', at: 't', segment: 'f1', afterUuid: null, from: 'a', to: 'b', ok: true }],
      unknownKey: { nested: [1, 2] },
    },
  } };
}

const flags = (doc) => Object.fromEntries(Object.values(doc.sessions).flatMap((r) =>
  r.segments.map((s) => [s.id, s.persistent === true ? 'P' : 'N'])));

test('a temp segment becomes normal and every other live non-archived segment becomes persistent', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', fixture());
  const res = await run(root);
  assert.equal(res.applied, true);
  const doc = await readJson(file(root, 'sessions.json'));
  const f = flags(doc);
  assert.deepEqual([f.a2, f.b3, f.d1, f.d2, f.e1, f.f1], ['N', 'P', 'P', 'N', 'P', 'P']);
  for (const r of Object.values(doc.sessions)) for (const s of r.segments) assert.equal('temp' in s, false, s.id);
});

test('an archived segment is persistent iff its record\'s current segment is live, not temp and not archived', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', fixture());
  await run(root);
  const f = flags(await readJson(file(root, 'sessions.json')));
  assert.equal(f.b1, 'P', 'the archived predecessor of a persistent session');
  assert.equal(f.a1, 'N', 'the archived predecessor of a normal session');
  assert.equal(f.c1, 'N', 'an exited normal session');
});

test('a tombstone carries no flag', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', fixture());
  await run(root);
  const b2 = (await readJson(file(root, 'sessions.json'))).sessions.bbbbbbbb.segments.find((s) => s.id === 'b2');
  assert.deepEqual(b2, seg('b2', 'prune', { dropped: true }));
});

test('every non-flag key survives and version 2 is written first', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', fixture());
  await run(root);
  const doc = await readJson(file(root, 'sessions.json'));
  assert.deepEqual(Object.keys(doc), ['version', 'sessions']);
  assert.equal(doc.version, 2);
  const strip = (d) => {
    for (const r of Object.values(d.sessions)) for (const s of r.segments) { delete s.temp; delete s.persistent; }
    return d.sessions;
  };
  assert.deepEqual(strip(doc), strip(fixture()));
});

test('a version-2 store holding only normal sessions is left byte-identical', async () => {
  const root = await mkRoot();
  const text = JSON.stringify({ version: 2, sessions: {
    aaaaaaaa: { current: 'a1', segments: [seg('a1', 'initial')] },
  } }, null, 2) + '\n';
  await fs.writeFile(file(root, 'sessions.json'), text);
  await fs.writeFile(file(root, 'sessions.json.bak'), text);
  assert.deepEqual(await run(root), { applied: false });
  assert.equal(await fs.readFile(file(root, 'sessions.json'), 'utf8'), text);
  assert.equal(await fs.readFile(file(root, 'sessions.json.bak'), 'utf8'), text);
  assert.equal(await exists(file(root, 'migrated-backup-0043')), false);
});

test('a second run is a no-op with identical bytes', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', fixture());
  await writeJson(root, 'sessions.json.bak', fixture());
  await run(root);
  const once = await fs.readFile(file(root, 'sessions.json'), 'utf8');
  const onceBak = await fs.readFile(file(root, 'sessions.json.bak'), 'utf8');
  assert.deepEqual(await run(root), { applied: false });
  assert.equal(await fs.readFile(file(root, 'sessions.json'), 'utf8'), once);
  assert.equal(await fs.readFile(file(root, 'sessions.json.bak'), 'utf8'), onceBak);
});

test('the pre-image lands in migrated-backup-0043 once', async (t) => {
  await t.test('both files are snapshotted before the transform', async () => {
    const root = await mkRoot();
    await writeJson(root, 'sessions.json', fixture());
    await writeJson(root, 'sessions.json.bak', { sessions: {} });
    const pre = await fs.readFile(file(root, 'sessions.json'), 'utf8');
    const preBak = await fs.readFile(file(root, 'sessions.json.bak'), 'utf8');
    await run(root);
    assert.equal(await fs.readFile(path.join(store(root), 'migrated-backup-0043', 'sessions.json'), 'utf8'), pre);
    assert.equal(await fs.readFile(path.join(store(root), 'migrated-backup-0043', 'sessions.json.bak'), 'utf8'), preBak);
  });
  await t.test('an existing backup dir is never overwritten', async () => {
    const root = await mkRoot();
    const dir = path.join(store(root), 'migrated-backup-0043');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'sessions.json'), 'ORIGINAL');
    await writeJson(root, 'sessions.json', fixture());
    await run(root);
    assert.equal(await fs.readFile(path.join(dir, 'sessions.json'), 'utf8'), 'ORIGINAL');
  });
  await t.test('a stale .tmp dir is replaced', async () => {
    const root = await mkRoot();
    const tmp = path.join(store(root), 'migrated-backup-0043.tmp');
    await fs.mkdir(tmp);
    await fs.writeFile(path.join(tmp, 'stale'), 'x');
    await writeJson(root, 'sessions.json', fixture());
    await run(root);
    assert.equal(await exists(tmp), false);
    assert.deepEqual((await fs.readdir(path.join(store(root), 'migrated-backup-0043'))).sort(), ['sessions.json']);
  });
});

test('a crash between steps leaves a state the next run finishes', async (t) => {
  await t.test('backup present, primary unversioned: the live primary is transformed', async () => {
    const root = await mkRoot();
    const dir = path.join(store(root), 'migrated-backup-0043');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'sessions.json'), 'PRE');
    await writeJson(root, 'sessions.json', fixture());
    const res = await run(root);
    assert.equal(res.applied, true);
    const doc = await readJson(file(root, 'sessions.json'));
    assert.equal(doc.version, 2);
    assert.equal(flags(doc).b3, 'P');
  });
  await t.test('primary v2, .bak unversioned: only .bak is transformed', async () => {
    const root = await mkRoot();
    const primary = JSON.stringify({ version: 2, sessions: { aaaaaaaa: { current: 'a1', segments: [seg('a1', 'initial')] } } });
    await fs.writeFile(file(root, 'sessions.json'), primary);
    await writeJson(root, 'sessions.json.bak', fixture());
    const res = await run(root);
    assert.deepEqual(res.summary.store.files, ['sessions.json.bak']);
    assert.equal(await fs.readFile(file(root, 'sessions.json'), 'utf8'), primary);
    const bak = await readJson(file(root, 'sessions.json.bak'));
    assert.equal(bak.version, 2);
    assert.equal(flags(bak).b3, 'P');
  });
});

test('store edge cases', async (t) => {
  await t.test('an unparseable primary is left in place and the .bak is migrated', async () => {
    const root = await mkRoot();
    await fs.writeFile(file(root, 'sessions.json'), '{torn');
    await writeJson(root, 'sessions.json.bak', fixture());
    const logs = [];
    const res = await run(root, (m) => logs.push(m));
    assert.equal(res.applied, true);
    assert.equal(await fs.readFile(file(root, 'sessions.json'), 'utf8'), '{torn');
    assert.equal((await readJson(file(root, 'sessions.json.bak'))).version, 2);
    assert.ok(logs.some((l) => l.includes('sessions.json is unparseable')), logs.join('\n'));
  });
  await t.test('an absent store creates nothing', async () => {
    const root = await mkRoot();
    assert.deepEqual(await run(root), { applied: false });
    assert.deepEqual(await fs.readdir(store(root)), []);
  });
});

test('restore-file entries carry persistent instead of temp', async (t) => {
  for (const name of ['pending-resume.json', 'running-sessions.json']) {
    await t.test(name, async () => {
      const root = await mkRoot();
      const clis = [{ sessionId: 's', pid: 1, start: null, group: true }];
      const workers = [{ sessionId: 'w', project: 'p' }];
      await writeJson(root, name, { writtenAt: 'W', deliver: 'auto', clis, instances: [
        { sessionId: 'n', temp: true, workers },
        { sessionId: 'p', temp: false },
        { sessionId: 'done', persistent: true },
      ] });
      const res = await run(root);
      assert.equal(res.summary.restoreEntries[name], 2);
      const out = await readJson(file(root, name));
      assert.deepEqual(out.instances, [
        { sessionId: 'n', workers, persistent: false },
        { sessionId: 'p', persistent: true },
        { sessionId: 'done', persistent: true },
      ]);
      assert.deepEqual(out.clis, clis);
      assert.equal(out.writtenAt, 'W');
      assert.equal(out.deliver, 'auto');
    });
  }
  await t.test('a torn file is left alone without throwing', async () => {
    const root = await mkRoot();
    await fs.writeFile(file(root, 'pending-resume.json'), '{"instances": [');
    assert.deepEqual(await run(root), { applied: false });
    assert.equal(await fs.readFile(file(root, 'pending-resume.json'), 'utf8'), '{"instances": [');
  });
});

test('pending-temp-cleanup.json is renamed to pending-archive.json', async (t) => {
  await t.test('renamed byte-identical', async () => {
    const root = await mkRoot();
    const text = '{"entries":[{"place":null,"sessionId":"x"}]}';
    await fs.writeFile(file(root, 'pending-temp-cleanup.json'), text);
    const res = await run(root);
    assert.equal(res.applied, true);
    assert.equal(await exists(file(root, 'pending-temp-cleanup.json')), false);
    assert.equal(await fs.readFile(file(root, 'pending-archive.json'), 'utf8'), text);
  });
  await t.test('an existing pending-archive.json leaves the old file alone', async () => {
    const root = await mkRoot();
    await fs.writeFile(file(root, 'pending-temp-cleanup.json'), 'OLD');
    await fs.writeFile(file(root, 'pending-archive.json'), 'NEW');
    assert.deepEqual(await run(root), { applied: false });
    assert.equal(await fs.readFile(file(root, 'pending-temp-cleanup.json'), 'utf8'), 'OLD');
    assert.equal(await fs.readFile(file(root, 'pending-archive.json'), 'utf8'), 'NEW');
  });
  await t.test('neither present is a no-op', async () => {
    const root = await mkRoot();
    assert.deepEqual(await run(root), { applied: false });
  });
});

test('after 0043, the whole chain over the store is silent', async () => {
  const root = await mkRoot();
  await writeJson(root, 'sessions.json', fixture());
  await writeJson(root, 'pending-resume.json', { instances: [{ sessionId: 'n', temp: true }] });
  await fs.writeFile(file(root, 'pending-temp-cleanup.json'), '{"entries":[]}');
  await runMigrations({ root, log: () => {} });
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
});
