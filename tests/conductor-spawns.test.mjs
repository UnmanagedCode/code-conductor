// Unit tests for src/conductorSpawns.ts: the root-conductor walk over recorded
// `parent` links and the per-root spawned-projects derivation behind the
// Conductors lens's idle chips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-conductor-spawns-'));
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');

const { parseSessionsDoc, markConducted, setTitle } = await import('../src/sessionStore.ts');
const { rootOf, spawnedProjectsByRoot, conductorSpawnedProjects } = await import('../src/conductorSpawns.ts');

let testNo = 0;
async function freshRoot() {
  const root = path.join(tmp, `root-${testNo++}`);
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  process.env.PROJECTS_ROOT = root;
  return root;
}

// One record per entry: `ats` are its segments' `at`s (the last is current).
function rec({ conducted = false, parent, project, ats = [''], archived = false } = {}, id) {
  const segments = ats.map((at, i) => ({ id: i === ats.length - 1 ? id : `${id}-old${i}`, reason: i === 0 ? 'initial' : 'renew', at }));
  if (archived) segments[segments.length - 1].archived = true;
  return {
    current: id, segments,
    ...(conducted ? { conducted: true } : {}),
    ...(parent ? { parent } : {}),
    ...(project ? { project } : {}),
  };
}
function docOf(spec) {
  const sessions = {};
  for (const [id, o] of Object.entries(spec)) sessions[id] = rec(o, id);
  return parseSessionsDoc({ sessions });
}

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

test('rootOf climbs conducted parents to the first non-conducted session', () => {
  const doc = docOf({
    C: {},
    W1: { conducted: true, parent: 'C', project: 'p' },
    W2: { conducted: true, parent: 'W1', project: 'q' },
  });
  assert.equal(rootOf(doc, 'W2'), 'C');
  assert.equal(rootOf(doc, 'W1'), 'C');
});

test('rootOf is null through a missing link, a pre-migration conducted ancestor, and a cycle', async (t) => {
  await t.test('an absent parent record', () => {
    assert.equal(rootOf(docOf({ W: { conducted: true, parent: 'GONE', project: 'p' } }), 'W'), null);
  });
  await t.test('a conducted ancestor with no parent', () => {
    const doc = docOf({ W1: { conducted: true, project: 'p' }, W2: { conducted: true, parent: 'W1', project: 'p' } });
    assert.equal(rootOf(doc, 'W2'), null);
  });
  await t.test('a cycle terminates as null', () => {
    const doc = docOf({ W1: { conducted: true, parent: 'W2', project: 'p' }, W2: { conducted: true, parent: 'W1', project: 'p' } });
    assert.equal(rootOf(doc, 'W1'), null);
    assert.equal(rootOf(doc, 'W2'), null);
  });
});

test('spawnedProjectsByRoot attributes nested workers to the root, one entry per project, newest spawn first', () => {
  const doc = docOf({
    C: {},
    W1: { conducted: true, parent: 'C', project: 'mid', ats: [T2] },
    W2: { conducted: true, parent: 'W1', project: 'grand', ats: [T1] },
    W3: { conducted: true, parent: 'C', project: 'dup', ats: [T1] },
    W4: { conducted: true, parent: 'C', project: 'dup', ats: [T3] },
    W5: { conducted: true, parent: 'C', project: 'alpha', ats: [T1] },
  });
  const out = spawnedProjectsByRoot(doc);
  assert.deepEqual(Object.keys(out), ['C'], 'nothing is attributed to the intermediate W1');
  assert.deepEqual(out.C, [
    { project: 'dup', lastSpawnAt: T3 },
    { project: 'mid', lastSpawnAt: T2 },
    { project: 'alpha', lastSpawnAt: T1 },
    { project: 'grand', lastSpawnAt: T1 },
  ]);
});

test('lastSpawnAt counts a rotation segment, not only the initial one', () => {
  const doc = docOf({ C: {}, W: { conducted: true, parent: 'C', project: 'p', ats: [T1, T3] } });
  assert.deepEqual(spawnedProjectsByRoot(doc).C, [{ project: 'p', lastSpawnAt: T3 }]);
});

test('records that are not conducted, or carry no project, contribute nothing', () => {
  const doc = docOf({
    C: {},
    H: { parent: 'C', project: 'hand' },
    W: { conducted: true, parent: 'C' },
  });
  assert.deepEqual(spawnedProjectsByRoot(doc), {});
});

test('a root whose current segment is archived is omitted', () => {
  const doc = docOf({
    GONE: { archived: true },
    KEPT: {},
    W1: { conducted: true, parent: 'GONE', project: 'p', ats: [T1] },
    W2: { conducted: true, parent: 'KEPT', project: 'q', ats: [T1] },
  });
  assert.deepEqual(spawnedProjectsByRoot(doc), { KEPT: [{ project: 'q', lastSpawnAt: T1 }] });
});

test('the result is memoised per doc object', () => {
  const spec = { C: {}, W: { conducted: true, parent: 'C', project: 'p', ats: [T1] } };
  const doc = docOf(spec);
  const a = spawnedProjectsByRoot(doc);
  assert.ok(spawnedProjectsByRoot(doc) === a, 'the same doc returns the same result object');
  const b = spawnedProjectsByRoot(docOf(spec));
  assert.ok(b !== a, 'a new doc is recomputed');
  assert.deepEqual(b, a);
});

test('conductorSpawnedProjects reads the store: a markConducted write shows up on the next read', async () => {
  await freshRoot();
  const C = 'cccccccc-0000-4000-8000-000000000003';
  const W = 'dddddddd-0000-4000-8000-000000000004';
  await setTitle(C, 'the conductor');
  assert.deepEqual(await conductorSpawnedProjects(), {});
  await markConducted(W, { parent: C, project: 'p' });
  const out = await conductorSpawnedProjects();
  assert.deepEqual(Object.keys(out), [C]);
  assert.deepEqual(out[C].map(e => e.project), ['p']);
  assert.equal(typeof out[C][0].lastSpawnAt, 'string');
  assert.ok(out[C][0].lastSpawnAt.length > 0);
});
