// describe_session's RETIRED branch builds its row from the requested session's
// own transcript(s) only: parity with the listing's row, and no sibling I/O.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as projects from '../src/projects.ts';
import { describeSession } from '../src/mcp/handlers.ts';
import { setSegmentArchived, markConducted } from '../src/sessionStore.ts';
import { mintPublicId, recordRotation } from '../src/sessionLineage.ts';
import { freshProjectsRoot, registerLocalProject, seedSessionJsonl, rmrf } from './helpers.mjs';

let home; let projectsRoot;
before(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
after(async () => { await rmrf(home); });

let n = 0;
const sid = () => `bb22cc33-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const user = (t) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: t }] } });
const asst = (id, blocks, stop, ts) => ({
  type: 'assistant', isSidechain: false, ...(ts ? { timestamp: ts } : {}),
  message: { id, role: 'assistant', content: blocks, ...(stop === undefined ? {} : { stop_reason: stop }) },
});
const text = (t) => ({ type: 'text', text: t });
const askTool = (id) => ({ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: 'q' }] } });
const T = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
const done = (id, min) => asst(id, [text('done')], 'end_turn', T(min));

async function fixture(label) {
  const dir = path.join(projectsRoot, `p-${label}-${++n}`);
  await registerLocalProject(`p-${label}-${n}`, dir);
  return { place: projects.localPlace(dir), dir };
}
const listRow = async (place, id) => (await projects.listSessionsForCwdWithCounts(place, null, { includeArchived: true })).rows
  .find(r => r.sessionId === id);
const describe = async (id) => (await describeSession({ sessionId: id }, {})).json;

// INVARIANT: per-file I/O of a retired describe is the requested session's files only.
test('retired describe opens and stats no sibling transcript', async () => {
  const { place, dir } = await fixture('io');
  const target = sid();
  await seedSessionJsonl(place, target, [user('go'), done('m0', 1)]);
  for (let i = 0; i < 20; i++) await seedSessionJsonl(place, sid(), [user(`sib ${i}`), done(`s${i}`, 2)]);
  const tdir = path.dirname(path.join(projects.sessionFilePath(place, target)));

  const touched = []; const listed = [];
  const orig = { open: fsp.open, stat: fsp.stat, list: fsp['read' + 'dir'] };
  fsp.open = (p, ...a) => { touched.push(String(p)); return orig.open(p, ...a); };
  fsp.stat = (p, ...a) => { touched.push(String(p)); return orig.stat(p, ...a); };
  fsp['read' + 'dir'] = (p, ...a) => { listed.push(String(p)); return orig.list(p, ...a); };
  let view;
  try { view = await describe(target); }
  finally { fsp.open = orig.open; fsp.stat = orig.stat; fsp['read' + 'dir'] = orig.list; }

  assert.equal(view.retired?.sessionId, target, 'premise: the row was served');
  const jsonl = touched.filter(p => p.endsWith('.jsonl'));
  assert.ok(jsonl.some(p => p === path.join(tdir, `${target}.jsonl`)), 'positive control: the target was opened or statted');
  assert.deepEqual(jsonl.filter(p => !p.endsWith(`${target}.jsonl`)), [], 'no sibling transcript opened or statted');
  assert.ok(!listed.includes(tdir), 'the transcript directory is not listed');
  void dir;
});

// INVARIANT: the retired row is the listing's row (plus the playbook binding).
test('retired row equals the list row (row-less, not archived)', async () => {
  const { place, dir } = await fixture('plain');
  const s = sid();
  await seedSessionJsonl(place, s, [user('hello there'), asst('m1', [askTool('tq')], 'tool_use', T(5))]);
  const view = await describe(s);
  const row = await listRow(place, s);
  assert.deepEqual(view.retired, { ...row, playbook: null, stage: null });
  assert.equal(view.path, dir);
  assert.equal(view.retired.awaitingUser, 'question');
});

// INVARIANT: public-id projection and chain derivation match the listing.
test('retired row of a renewed session (minted public id) equals the list row', async () => {
  const { place } = await fixture('renew');
  const first = sid(); const second = sid();
  await seedSessionJsonl(place, first, [user('go'), asst('m1', [askTool('tq')], 'tool_use', T(1))]);
  await seedSessionJsonl(place, second, [asst('m2', [text('summary')], 'end_turn', T(9))]);
  const publicId = await mintPublicId(first);
  await recordRotation(publicId, second, 'renew');
  const view = await describe(publicId);
  assert.deepEqual(view.retired, { ...(await listRow(place, publicId)), playbook: null, stage: null });
  assert.equal(view.retired.size, (await fsp.stat(projects.sessionFilePath(place, second))).size, 'the current segment');
});

// INVARIANT: an archived row is derived (awaitingUser), the one difference from the list row.
test('archived row: list row except awaiting fields, which are derived', async () => {
  const { place } = await fixture('arch');
  const s = sid();
  await seedSessionJsonl(place, s, [user('go'), asst('m1', [askTool('tq')], 'tool_use', T(3))]);
  await setSegmentArchived(s, true);
  const view = await describe(s);
  const row = await listRow(place, s);
  assert.deepEqual({ ...view.retired, awaitingUser: null, awaitingUserSource: null, playbook: undefined, stage: undefined },
    { ...row, playbook: undefined, stage: undefined });
  assert.equal(view.retired.awaitingUser, 'question');
  assert.equal(view.retired.awaitingUserSource, 'tool');
});

// INVARIANT: a conducted row never carries the flag, archived or not.
test('archived conducted row reports awaitingUser null', async () => {
  const { place } = await fixture('cond');
  const s = sid();
  await seedSessionJsonl(place, s, [user('go'), asst('m1', [askTool('tq')], 'tool_use', T(3))]);
  await setSegmentArchived(s, true);
  await markConducted(s);
  const view = await describe(s);
  assert.equal(view.retired.awaitingUser, null);
  assert.equal(view.retired.awaitingUserSource, null);
});

// INVARIANT: a legacy full-UUID record has two candidate files; the one with the
// greater lastActivity is the row, as in the listing.
async function legacy(label, currentMin, supersededMin) {
  const { place } = await fixture(label);
  const x = sid(); const y = sid();
  await seedSessionJsonl(place, x, [user('old'), done('mx', supersededMin)]);
  await seedSessionJsonl(place, y, [user('new'), done('my', currentMin), done('my2', currentMin)]);
  await recordRotation(x, y, 'renew');
  const view = await describe(x);
  const row = await listRow(place, x);
  assert.deepEqual(view.retired, { ...row, playbook: null, stage: null });
  return { view, sizeOf: async (s) => (await fsp.stat(projects.sessionFilePath(place, s))).size, x, y };
}
test('legacy full-UUID public id, current newer → current segment row', async () => {
  const { view, sizeOf, y } = await legacy('legacy-cur', 20, 2);
  assert.equal(view.retired.size, await sizeOf(y));
});
test('legacy full-UUID public id, superseded newer → superseded row', async () => {
  const { view, sizeOf, x } = await legacy('legacy-sup', 2, 20);
  assert.equal(view.retired.size, await sizeOf(x));
});

// Step B: helper-level (namespace import: a missing export must not red the file at load).
test('sessionRowForCwd returns null for a located id whose file is gone', async () => {
  const { place } = await fixture('gone');
  assert.equal(await projects.sessionRowForCwd(place, sid()), null);
});
test('sessionRowForCwd(place, <current backing sid>) is null: a backing id names no row', async () => {
  const { place } = await fixture('backing');
  const first = sid(); const second = sid();
  await seedSessionJsonl(place, first, [user('go'), done('m1', 1)]);
  await seedSessionJsonl(place, second, [done('m2', 2)]);
  const publicId = await mintPublicId(first);
  await recordRotation(publicId, second, 'renew');
  assert.equal(await projects.sessionRowForCwd(place, second), null);
  assert.equal((await projects.sessionRowForCwd(place, publicId)).sessionId, publicId);
});
