// POST /api/instances/:id/rewind with `{ boundary }` — undoing the latest
// renewal at its "Context renewed" divider (Instance.rewindAcrossRenewal). Each
// test seeds a multi-segment chain (synthetic, specimen-shaped transcripts:
// tests/renewalFixtures.mjs) and resumes it by public id, so the live backing
// segment is the chain's current one. The fake writes no jsonl; with
// `strict_resume` a relaunch that `--resume`s a file with no conversation dies
// at startup, as the real CLI does.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { SwitchLauncher } from './switchLauncher.mjs';
import { seedSegmentChain, segmentTurns, stubbedCopy, writeLineageRow } from './segmentChain.mjs';
import {
  preRenewalRecords, postRenewalRecords, postTypedClearRecords, declinedRequest,
} from './renewalFixtures.mjs';
import { localPlace, sessionFilePath, subAgentDirPath, orchStoreRoot } from '../src/projects.ts';
import { settleSessionWrites } from '../src/sessionStore.ts';
import { chainFor, resolveBacking } from '../src/sessionLineage.ts';
import { isPureUserPromptLine } from '../src/transcript.ts';
import { RELAUNCH_FAILED, RENEWAL_NOT_LATEST, PRE_RENEWAL_GONE } from '../src/instances.ts';
import { NOT_A_RENEWAL_BOUNDARY } from '../src/renewalBoundary.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume-strict.json');
const SCENARIO_OPEN_TURN = path.join(__dirname, 'fixtures', 'scenario-open-turn.json');

let ctx, baseUrl, instances, launcher, home, projectsRoot;
before(async () => {
  launcher = new SwitchLauncher();
  ctx = await bootServer({ scenarioPath: SCENARIO, claudeLauncher: launcher });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home, projectsRoot } = await freshProjectsRoot());
  launcher.plan = [];
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
});
afterEach(async () => { await instances.shutdown(); await settleSessionWrites(); await rmrf(home); });

let n = 0;
// A fresh UUID-shaped segment id; the public id is a chain's first 8 chars.
const sid = () => { n += 1; const h = (0xa0000000 + n).toString(16); return `${h}-0000-4000-8000-00000000000${n % 10}`; };
const place = () => localPlace(path.join(projectsRoot, 'p'));
const parse = (text) => text.split('\n').filter(Boolean).map(l => JSON.parse(l));
const promptsOf = async (id) => parse(await fs.readFile(sessionFilePath(place(), id), 'utf8'))
  .filter(isPureUserPromptLine).map(o => (typeof o.message?.content === 'string' ? o.message.content : '?'));
const echoes = (inst) => inst.ringSnapshot().filter(e => e.kind === 'user_echo' && !e.parentToolUseId).map(e => e.text);
// The record's chain: `current` and `segments` (a running session writes its
// own facts, e.g. its backend, beside them).
const storeChain = async (pub) => {
  const { current, segments } = JSON.parse(await fs.readFile(path.join(orchStoreRoot(), 'sessions.json'), 'utf8')).sessions[pub];
  return { current, segments };
};
const fileBytes = (id) => fs.readFile(sessionFilePath(place(), id), 'utf8');
const undo = (inst, body) => api(baseUrl, 'POST', `/api/instances/${inst.id}/rewind`, body);

// Seed `segments` (segmentChain shape: {id, reason, records, archived?, temp?})
// as one chain and resume it by public id.
async function resumeChain(segments, { temp = false, scenario = null } = {}) {
  const publicId = segments[0].id.slice(0, 8);
  await seedSegmentChain({ place: place(), publicId, segments });
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  if (scenario) process.env.FAKE_CLAUDE_SCENARIO = scenario;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'p', mode: 'bypassPermissions', resume: publicId, ...(temp ? { temp: true } : {}),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle' && inst.proc);
    assert.equal(inst.backingSessionId, segments.filter(s => !s.dropped).at(-1).id, 'resumed onto the current segment');
    inst._relaunchGraceMs = 50;
    return { inst, publicId };
  } finally {
    if (scenario) process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
}

// A managed renewal: P (archived, as a rotation leaves it) → N (current).
function managedChain(tag, { temp = false } = {}) {
  const P = sid(), N = sid();
  return {
    P, N,
    segments: [
      { id: P, reason: 'initial', archived: true, records: preRenewalRecords(tag) },
      { id: N, reason: 'renew', ...(temp ? { temp: true } : {}), records: postRenewalRecords(tag) },
    ],
  };
}

async function lifecycleOf(inst, fn) {
  const seen = [];
  const onLaunch = (a) => { if (a.sessionId === inst.sessionId) seen.push(['launch', a.event, a.cause]); };
  const onExit = (x) => { if (x.sessionId === inst.sessionId) seen.push(['exit']); };
  instances.on('session_launched', onLaunch);
  instances.on('session_exited', onExit);
  try { await fn(); } finally {
    instances.off('session_launched', onLaunch);
    instances.off('session_exited', onExit);
  }
  return seen;
}

test('undoing the latest managed renewal relaunches the pre-renewal segment cut before the request', async () => {
  const { P, N, segments } = managedChain('m', { temp: true });
  const { inst, publicId } = await resumeChain(segments, { temp: true });
  const agents = subAgentDirPath(place(), N);
  await fs.mkdir(agents, { recursive: true });
  await fs.writeFile(path.join(agents, 'agent-x.jsonl'), '{}\n');

  const r = await undo(inst, { boundary: N });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.droppedText, null, 'nothing to prefill');

  const chain = await chainFor(publicId);
  assert.deepEqual(chain.map(s => [s.id, !!s.archived, !!s.temp]), [[P, false, true]],
    'segments [P], P un-archived and temp again');
  assert.equal(await resolveBacking(publicId), P, 'current is P');
  assert.deepEqual(await promptsOf(P), ['m brief', declinedRequest('m')], 'P keeps only the prompts before the request');
  assert.equal(existsSync(sessionFilePath(place(), N)), false, 'N\'s jsonl is deleted');
  assert.equal(existsSync(agents), false, 'N\'s sub-agent dir is deleted');

  await waitFor(() => inst.status === 'idle' && inst.proc);
  assert.equal(inst.backingSessionId, P);
  assert.equal(inst.sessionId, publicId, 'the public id is unchanged');
  assert.equal(inst.summary().segmentCount, 1);
  assert.equal(inst.temp, true);
  assert.deepEqual(echoes(inst), ['m brief', declinedRequest('m')], 'the ring is P\'s surviving conversation');

  await inst.prompt('carry on');
  await waitFor(() => echoes(inst).includes('carry on') && inst.status === 'idle');
});

// The flag a launch was started with, and its value.
const launchedWith = (inst, flag, id) => {
  const argv = inst._spawnArgv ?? [];
  const at = argv.indexOf(flag);
  return at !== -1 && argv[at + 1] === id;
};

test('undoing a renewal requested by the pre segment\'s first prompt relaunches fresh under the pre segment id', async () => {
  const P = sid(), N = sid();
  const { inst, publicId } = await resumeChain([
    { id: P, reason: 'initial', archived: true, records: preRenewalRecords('z').slice(4) },
    { id: N, reason: 'renew', records: postRenewalRecords('z') },
  ]);
  const r = await undo(inst, { boundary: N });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor(() => inst.status === 'idle' && inst.proc);
  assert.equal(inst.backingSessionId, P);
  assert.ok(launchedWith(inst, '--session-id', P), `relaunched fresh as --session-id ${P}: ${JSON.stringify(inst._spawnArgv)}`);
  assert.equal(launchedWith(inst, '--session-id', N) || launchedWith(inst, '--resume', N), false, 'not on the discarded post segment');
  assert.deepEqual((await chainFor(publicId)).map(s => s.id), [P]);
  assert.deepEqual(echoes(inst), [], 'nothing survives the cut');
});

test('undoing a typed /clear restores the pre-clear segment whole', async () => {
  const P = sid(), N = sid();
  const { inst, publicId } = await resumeChain([
    { id: P, reason: 'initial', archived: true, records: segmentTurns('t', 2) },
    { id: N, reason: 'renew', records: postTypedClearRecords('t') },
  ]);
  const before = await fileBytes(P);
  const r = await undo(inst, { boundary: N });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await fileBytes(P), before, 'P is byte-identical');
  assert.deepEqual((await chainFor(publicId)).map(s => [s.id, !!s.archived, !!s.temp]), [[P, false, false]]);
  assert.equal(existsSync(sessionFilePath(place(), N)), false);
  await waitFor(() => inst.status === 'idle' && inst.proc);
  assert.deepEqual(echoes(inst), ['t prompt 0', 't prompt 1']);
});

test('only the latest renewal can be undone', async () => {
  const A = sid(), B = sid(), C = sid();
  const { inst, publicId } = await resumeChain([
    { id: A, reason: 'initial', archived: true, records: preRenewalRecords('a') },
    { id: B, reason: 'renew', archived: true, records: [...postRenewalRecords('b'), ...preRenewalRecords('b')] },
    { id: C, reason: 'renew', records: postRenewalRecords('c') },
  ]);
  const files = await Promise.all([A, B, C].map(fileBytes));
  const record = await storeChain(publicId);
  const proc = inst.proc;
  const r = await undo(inst, { boundary: B });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, RENEWAL_NOT_LATEST);
  assert.match(r.body.error, /fork from this divider instead/);
  assert.deepEqual(await Promise.all([A, B, C].map(fileBytes)), files, 'every file is byte-identical');
  assert.deepEqual(await storeChain(publicId), record, 'the chain is unchanged');
  assert.ok(inst.proc === proc, 'the process was not killed');
});

test('undoing a renewal followed by a prune drops both', async () => {
  const A = sid(), B = sid(), C = sid();
  const { inst, publicId } = await resumeChain([
    { id: A, reason: 'initial', archived: true, records: preRenewalRecords('a') },
    { id: B, reason: 'renew', archived: true, records: postRenewalRecords('b') },
    { id: C, reason: 'prune', records: stubbedCopy(postRenewalRecords('b'), '[pruned]') },
  ]);
  const r = await undo(inst, { boundary: C });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await chainFor(publicId)).map(s => s.id), [A]);
  assert.equal(existsSync(sessionFilePath(place(), B)), false);
  assert.equal(existsSync(sessionFilePath(place(), C)), false);
  assert.deepEqual(await promptsOf(A), ['a brief', declinedRequest('a')]);
  await waitFor(() => inst.status === 'idle' && inst.proc);
  assert.equal(inst.backingSessionId, A);
});

// Each refusal: the given status (and code), with every file, the record and
// the process untouched.
async function assertRefusalChangesNothing({ inst, publicId, ids }, body, { status, code, error }) {
  const files = await Promise.all(ids.map(id => fileBytes(id).catch(() => null)));
  const record = await storeChain(publicId);
  const proc = inst.proc;
  const r = await undo(inst, body);
  assert.equal(r.status, status, JSON.stringify(r.body));
  if (code) assert.equal(r.body.code, code);
  if (error) assert.match(r.body.error, error);
  assert.deepEqual(await Promise.all(ids.map(id => fileBytes(id).catch(() => null))), files, 'files unchanged');
  assert.deepEqual(await storeChain(publicId), record, 'chain unchanged');
  assert.ok(inst.proc === proc, 'the process was not killed');
}

test('a refused undo changes nothing: a held _mutating claim is refused 409', async () => {
    const { P, N, segments } = managedChain('h');
    const { inst, publicId } = await resumeChain(segments);
    inst._mutating = 'fork';
    try {
      await assertRefusalChangesNothing({ inst, publicId, ids: [P, N] }, { boundary: N },
        { status: 409, error: /another rewind\/fork\/prune is in progress/ });
      assert.equal(inst._mutating, 'fork', 'the other claim is left alone');
    } finally { inst._mutating = null; }
});

test('a refused undo changes nothing: a rotation in flight is refused 409 SESSION_ROTATING', async () => {
    const { P, N, segments } = managedChain('r');
    const { inst, publicId } = await resumeChain(segments);
    inst.beginRenewal();
    try {
      await assertRefusalChangesNothing({ inst, publicId, ids: [P, N] }, { boundary: N }, { status: 409, code: 'SESSION_ROTATING' });
    } finally { inst.endRenewal(); }
});

test('a refused undo changes nothing: a bad or mixed body is refused 400', async () => {
    const { P, N, segments } = managedChain('b');
    const { inst, publicId } = await resumeChain(segments);
    const ctxOf = { inst, publicId, ids: [P, N] };
    await assertRefusalChangesNothing(ctxOf, { boundary: '../etc' }, { status: 400, error: /boundary must be a segment id/ });
    await assertRefusalChangesNothing(ctxOf, { boundary: 42 }, { status: 400, error: /boundary must be a segment id/ });
    await assertRefusalChangesNothing(ctxOf, { boundary: N, text: 'x' }, { status: 400, error: /cannot be combined/ });
    await assertRefusalChangesNothing(ctxOf, { boundary: N, userMessageIndex: 0 }, { status: 400, error: /cannot be combined/ });
});

test('a refused undo changes nothing: a label that is no renewal boundary is refused 400 NOT_A_RENEWAL_BOUNDARY', async () => {
    const { P, N, segments } = managedChain('l');
    const { inst, publicId } = await resumeChain(segments);
    await assertRefusalChangesNothing({ inst, publicId, ids: [P, N] }, { boundary: P }, { status: 400, code: NOT_A_RENEWAL_BOUNDARY });
});

test('a refused undo changes nothing: a missing pre-renewal file is refused 409 PRE_RENEWAL_GONE', async () => {
    const { P, N, segments } = managedChain('g');
    const { inst, publicId } = await resumeChain(segments);
    await fs.rm(sessionFilePath(place(), P));
    await assertRefusalChangesNothing({ inst, publicId, ids: [P, N] }, { boundary: N }, { status: 409, code: PRE_RENEWAL_GONE });
});

test('a refused undo changes nothing: a running turn is refused 409', async () => {
    const { P, N, segments } = managedChain('t');
    const { inst, publicId } = await resumeChain(segments, { scenario: SCENARIO_OPEN_TURN });
    await inst.prompt('a long turn');
    await waitFor(() => inst.status === 'turn');
    await assertRefusalChangesNothing({ inst, publicId, ids: [P, N] }, { boundary: N },
      { status: 409, error: /cannot rewind during a running turn/ });
});

test('a failure before the record write leaves P byte-identical and relaunches the untouched post segment', async () => {
  const { P, N, segments } = managedChain('x');
  const { inst, publicId } = await resumeChain(segments);
  const pBefore = await fileBytes(P);
  const nBefore = await fileBytes(N);
  // Once the process is down — after every refusal, before the truncate — the
  // chain moves on (another renewal lands), so undoRenewal refuses RENEWAL_MOVED.
  const moved = [...segments, { id: sid(), reason: 'renew' }];
  const kill = inst.kill.bind(inst);
  let chainBefore = null;
  inst.kill = async (...args) => {
    await kill(...args);
    if (chainBefore === null) { await writeLineageRow(publicId, moved); chainBefore = await storeChain(publicId); }
  };

  const r = await undo(inst, { boundary: N });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'RENEWAL_MOVED');
  assert.equal(await fileBytes(P), pBefore, 'P is byte-identical');
  assert.equal(await fileBytes(N), nBefore, 'N is untouched');
  assert.deepEqual(await storeChain(publicId), chainBefore, 'the undo wrote nothing to the record');
  await waitFor(() => inst.status === 'idle' && inst.proc);
  assert.equal(inst.backingSessionId, N, 'the post segment runs again');
  assert.equal(inst._mutating, null);
  assert.equal(inst.relaunching, false);
});

test('a relaunch failure after the undo reports 500 with the undone state kept', async () => {
  const { P, N, segments } = managedChain('f');
  const { inst, publicId } = await resumeChain(segments);
  launcher.plan.push({ crash: 'boom at startup' });
  const r = await undo(inst, { boundary: N });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.code, RELAUNCH_FAILED);
  assert.match(r.body.error, /the renewal was undone, but the session failed to relaunch: boom at startup/);
  assert.deepEqual((await chainFor(publicId)).map(s => s.id), [P], 'the undo stands');
  assert.equal(existsSync(sessionFilePath(place(), N)), false);
  assert.equal(inst.backingSessionId, P);
  assert.equal(inst.proc, null, 'nothing left running');
  assert.equal(inst.relaunching, false, 'the window is closed');
  assert.equal(inst._mutating, null, 'the claim is released');
});

test('the undo logs session exit + resume with cause rewind', async () => {
  const { N, segments } = managedChain('e');
  const { inst } = await resumeChain(segments);
  const seen = await lifecycleOf(inst, async () => {
    const r = await undo(inst, { boundary: N });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => inst.status === 'idle' && inst.proc);
  });
  assert.deepEqual(seen, [['exit'], ['launch', 'resume', 'rewind']]);
});
