// Fork and rewind of a bubble in an instance whose backing jsonl rotated live
// (a managed renew or a typed `/clear`). A bubble's `userIndex` is the live echo
// ordinal, which runs on across the seam, while fork/rewind count prompt lines
// in the CURRENT segment's file — which opens with a `/clear` head the live ring
// never emitted. Both must still land on exactly the clicked prompt, whether the
// bubble is ring-resident, was evicted after rendering live, or is served from
// the archive; and when the prompt cannot be placed they refuse, changing
// nothing.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { sessionFilePath } from '../src/projects.ts';
import { isPureUserPromptLine } from '../src/transcript.ts';
import {
  RENEW_HEAD, segmentTurns, bootLiveAcrossSeams, rotate, replaySlice, emitLive, withRingCap,
} from './segmentChain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

let ctx, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

// Renew-segment prompts; the ring cap lands the ring head inside them.
const M = 8;
const RING_CAP = 10;
const S1_PROMPT = /^s1 prompt (\d+)$/;

// Every boot gets fresh ids (its public id is the initial id's first 8 chars).
let boots = 0;
function chainIds() {
  const n = String(++boots).padStart(8, '0');
  return { s0: `${n}-0000-4000-8000-000000000000`, s1: `${n}-0000-4000-8000-000000000001` };
}

// A renewed instance: C prompts resumed live from s0, then a live renew onto s1
// (RENEW_HEAD + M prompts), with s1's content emitted as live ring content.
async function bootRenewed(C, { ringCap = RING_CAP } = {}) {
  const ids = chainIds();
  const project = `p${boots}`;
  const booted = await bootLiveAcrossSeams({
    ctx, project, publicId: ids.s0.slice(0, 8), ringCap,
    segments: [
      { id: ids.s0, reason: 'initial', records: segmentTurns('s0', C) },
      { id: ids.s1, reason: 'renew', records: segmentTurns('s1', M) },
    ],
  });
  const file = sessionFilePath(booted.place, ids.s1);
  return { ...booted, ids, project, file, fileText: await fs.readFile(file, 'utf8') };
}

const parseLines = (text) => text.split('\n').filter(l => l.length).map(l => JSON.parse(l));

// The seeded renew file's own shape, asserted before any test relies on it: the
// CLI's caveat (isMeta, string content), then the `/clear` command line.
function assertSeededShape(fileText) {
  const recs = parseLines(fileText);
  assert.equal(recs[0].isMeta, true, 'fixture: the file opens on an isMeta line');
  assert.equal(typeof recs[0].message.content, 'string');
  assert.match(recs[0].message.content, /^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/, 'fixture: …the CLI caveat');
  assert.match(recs[1].message.content, /^<command-name>\/clear<\/command-name>/, 'fixture: then the /clear command line');
}

// Of the renew head's lines only `/clear` is a prompt line.
function headPromptLines(fileText) {
  const recs = parseLines(fileText);
  return recs.slice(0, recs.findIndex(r => r.message?.content === 's1 prompt 0')).filter(isPureUserPromptLine).length;
}

// Live stamp of each `s1 prompt j`, as emitted crossing the seam.
function liveStamps(crossed) {
  const out = new Map();
  for (const e of crossed[0]) {
    const m = e.kind === 'user_echo' && S1_PROMPT.exec(e.text ?? '');
    if (m) out.set(Number(m[1]), e.userIndex);
  }
  assert.equal(out.size, M, 'fixture: every s1 prompt crossed live');
  return out;
}

// Page GET /events backward until hasMore is false; oldest-first.
async function pageAll(id, { limit = 7 } = {}) {
  let all = [];
  let cursor;
  for (let i = 0; i < 200; i++) {
    const q = cursor == null ? `?limit=${limit}` : `?before=${cursor}&limit=${limit}`;
    const r = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events${q}`);
    assert.equal(r.status, 200);
    all = r.body.events.concat(all);
    if (!r.body.hasMore) return all;
    cursor = r.body.nextBefore;
  }
  throw new Error('pageAll: cursor never terminated');
}

// Where each `s1 prompt j` bubble is served from, and the userIndex it carries
// there: `archive` (below the ring) or `ring`.
async function servedBubbles(inst, id) {
  const tb = inst.ring.trimmedBefore;
  const out = new Map();
  for (const e of await pageAll(id)) {
    const m = e.kind === 'user_echo' && !e.parentToolUseId && S1_PROMPT.exec(e.text ?? '');
    if (m) out.set(Number(m[1]), { userIndex: e.userIndex, source: e._seq < tb ? 'archive' : 'ring' });
  }
  const sources = new Set([...out.values()].map(b => b.source));
  assert.ok(sources.has('archive') && sources.has('ring'),
    `fixture: the ring head lands inside s1 (sources: ${[...sources]})`);
  return out;
}

// Record index of `s1 prompt j` in the seeded file.
function promptRecordIndex(fileText, j) {
  const idx = parseLines(fileText).findIndex(r => r.message?.content === `s1 prompt ${j}`);
  assert.ok(idx > 0);
  return idx;
}

// A written jsonl is exactly `expected` records, then the resume-picker pair.
function assertPrefixThenMetadata(written, expected, what) {
  assert.deepEqual(written.slice(0, expected.length), expected, `${what}: the prefix, verbatim`);
  assert.deepEqual(written.slice(expected.length).map(r => r.type), ['last-prompt', 'permission-mode'],
    `${what}: followed by the resume-picker metadata only`);
}

const dirListing = async (file) => (await fs.readdir(path.dirname(file))).sort();

async function exportedConstant(name) {
  const mod = await import('../src/sessionEdit.ts');
  const inst = await import('../src/instances.ts');
  const v = mod[name] ?? inst[name];
  assert.equal(typeof v, 'string', `${name} is exported`);
  return v;
}

test('archive-served current-segment echoes carry the live stamp of their twin', async (t) => {
  for (const C of [1, 2, 5]) {
    await t.test(`C=${C}`, async () => {
      const { inst, id, crossed, fileText } = await bootRenewed(C);
      assertSeededShape(fileText);
      const live = liveStamps(crossed);
      const served = await servedBubbles(inst, id);
      for (const [j, b] of served) {
        assert.equal(b.userIndex, live.get(j), `s1 prompt ${j} (${b.source}) carries its live stamp`);
      }
      assert.equal(headPromptLines(fileText), 1, 'the renew head holds exactly one prompt line');
    });
  }
});

test('fork of every current-segment bubble targets exactly the clicked prompt', async (t) => {
  for (const C of [1, 2, 5]) {
    await t.test(`C=${C}`, async () => {
      const { inst, id, crossed, file, fileText } = await bootRenewed(C);
      assertSeededShape(fileText);
      const live = liveStamps(crossed);
      const served = await servedBubbles(inst, id);
      const ring = new Set(inst.ringSnapshot().filter(e => e.kind === 'user_echo').map(e => e.text));
      const src = parseLines(fileText);
      for (let j = 0; j < M; j++) {
        // Every index a client can hold for this prompt: the stamp it rendered
        // live (ring-resident, or since evicted) and the one a page walk served.
        const clicks = new Map([[live.get(j), ring.has(`s1 prompt ${j}`) ? 'ring' : 'evicted-live']]);
        const s = served.get(j);
        if (s && !clicks.has(s.userIndex)) clicks.set(s.userIndex, s.source);
        for (const [userMessageIndex, how] of clicks) {
          const text = `s1 prompt ${j}`;
          const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex, text });
          assert.equal(fk.status, 201, `fork ${how} ${text} @${userMessageIndex}: ${JSON.stringify(fk.body)}`);
          assert.equal(fk.body.droppedText, text, `fork ${how} ${text}: dropped the clicked prompt`);
          const forkFile = sessionFilePath(inst.transcriptPlace, fk.body.newSessionId);
          assertPrefixThenMetadata(parseLines(await fs.readFile(forkFile, 'utf8')),
            src.slice(0, promptRecordIndex(fileText, j)), `fork ${how} ${text}`);
        }
      }
      assert.equal(await fs.readFile(file, 'utf8'), fileText, 'the source file is untouched');
    });
  }
});

// One rewind per boot (a rewind rewrites the file and resets the ring).
async function rewindCase(t, source) {
  for (const C of [1, 2, 5]) {
    await t.test(`C=${C}`, async () => {
      const { inst, id, file, fileText } = await bootRenewed(C);
      assertSeededShape(fileText);
      const served = await servedBubbles(inst, id);
      const [j, b] = [...served].find(([, v]) => v.source === source);
      const text = `s1 prompt ${j}`;
      const rw = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: b.userIndex, text });
      assert.equal(rw.status, 200, `rewind ${source} ${text}: ${JSON.stringify(rw.body)}`);
      assert.equal(rw.body.droppedText, text, 'dropped the clicked prompt');
      assertPrefixThenMetadata(parseLines(await fs.readFile(file, 'utf8')),
        parseLines(fileText).slice(0, promptRecordIndex(fileText, j)), `rewind ${text}`);
      await waitFor(() => inst.status === 'idle');
    });
  }
}

test('rewind of an archive-served bubble truncates exactly before it', async (t) => {
  await rewindCase(t, 'archive');
});

test('rewind of a ring-resident bubble truncates exactly before it', async (t) => {
  await rewindCase(t, 'ring');
});

test('a mismatched text refuses fork before writing', async () => {
  const { id, crossed, file, fileText } = await bootRenewed(2);
  const listing = await dirListing(file);
  const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`,
    { userMessageIndex: liveStamps(crossed).get(M - 1), text: 'not the prompt at that index' });
  assert.equal(fk.status, 409, JSON.stringify(fk.body));
  assert.ok(fk.body.error.startsWith(await exportedConstant('PROMPT_MISMATCH')), fk.body.error);
  assert.deepEqual(await dirListing(file), listing, 'no fork file was written');
  assert.equal(await fs.readFile(file, 'utf8'), fileText, 'the source is byte-identical');
});

test('a mismatched text refuses rewind before the kill', async () => {
  const { inst, id, crossed, file, fileText } = await bootRenewed(2);
  const pid = inst.proc.pid;
  const status = inst.status;
  const resets = [];
  inst.on('snapshot_reset', (f) => resets.push(f));
  const rw = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rewind`,
    { userMessageIndex: liveStamps(crossed).get(M - 1), text: 'not the prompt at that index' });
  assert.equal(rw.status, 409, JSON.stringify(rw.body));
  assert.ok(rw.body.error.startsWith(await exportedConstant('PROMPT_MISMATCH')), rw.body.error);
  assert.equal(await fs.readFile(file, 'utf8'), fileText, 'the file is byte-identical');
  assert.equal(inst.proc?.pid, pid, 'the process was not killed');
  assert.equal(inst.status, status);
  assert.deepEqual(resets, [], 'no reset_snapshot was broadcast');
});

test('an uncalibratable ring refuses rather than guesses', async () => {
  const ids = chainIds();
  const { inst, id } = await bootLiveAcrossSeams({
    ctx, project: `p${boots}`, publicId: ids.s0.slice(0, 8), ringCap: 1000,
    segments: [
      { id: ids.s0, reason: 'initial', records: segmentTurns('s0', 2) },
    ],
  });
  // A renew seam whose ring content is absent from the file: nothing correlates.
  await withRingCap(1000, async () => {
    await fs.writeFile(sessionFilePath(inst.transcriptPlace, ids.s1),
      [...RENEW_HEAD, ...segmentTurns('s1', 2)].map(r => JSON.stringify(r)).join('\n') + '\n');
    await rotate(inst, ids.s1);
    emitLive(inst, { echo: 's1 prompt 0', msgId: 'never-persisted', blocks: 1 });
  });
  const echo = inst.ringSnapshot().findLast(e => e.kind === 'user_echo');
  const listing = await dirListing(sessionFilePath(inst.transcriptPlace, ids.s1));
  const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: echo.userIndex, text: echo.text });
  assert.equal(fk.status, 409, JSON.stringify(fk.body));
  assert.ok(fk.body.error.startsWith(await exportedConstant('PROMPT_UNRESOLVED')), fk.body.error);
  assert.deepEqual(await dirListing(sessionFilePath(inst.transcriptPlace, ids.s1)), listing, 'no fork file was written');
});

test('missing text is a 400', async (t) => {
  for (const route of ['fork', 'rewind']) {
    await t.test(route, async () => {
      const { id, crossed, file, fileText } = await bootRenewed(2);
      const r = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/${route}`, { userMessageIndex: liveStamps(crossed).get(0) });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /text must be a string/);
      assert.equal(await fs.readFile(file, 'utf8'), fileText);
    });
  }
});

// ── restamp refusals and the translation's guards ───────────────────────────

const archiveEchoes = async (inst, id) => {
  const tb = inst.ring.trimmedBefore;
  return (await pageAll(id)).filter(e => e.kind === 'user_echo' && !e.parentToolUseId && e._seq < tb);
};

test('an unmeasurable offset serves archive echoes with no userIndex', async () => {
  // One giant s1 turn: the trim falls back to a quiescent point inside it, so
  // the ring head's own content correlates (the correlated cut needs no offset)
  // while no outer echo precedes any correlating ring event.
  const ids = chainIds();
  const big = { type: 'assistant', uuid: 's1-aBig', message: { id: 's1-mBig', role: 'assistant',
    content: Array.from({ length: 12 }, (_, i) => ({ type: 'text', text: `s1 big block ${i}` })) } };
  const { inst, id } = await bootLiveAcrossSeams({
    ctx, project: `p${boots}`, publicId: ids.s0.slice(0, 8), ringCap: RING_CAP,
    segments: [
      { id: ids.s0, reason: 'initial', records: segmentTurns('s0', 2) },
      { id: ids.s1, reason: 'renew', records: [
        { type: 'user', uuid: 's1-uBig', message: { role: 'user', content: 's1 big prompt' } }, big,
      ] },
    ],
  });
  const ring = inst.ringSnapshot();
  assert.equal(ring[0].kind, 'text_delta', 'fixture: the ring head is mid-turn');
  assert.equal(ring[0].msgId, 's1-mBig', 'fixture: inside the persisted big reply');
  assert.ok(!ring.some(e => e.kind === 'user_echo' && !e.parentToolUseId), 'fixture: no outer echo in the ring');
  assert.ok(inst.ring.trimmedBefore >= inst.ring.seams.at(-1).startSeq, 'fixture: the ring head is inside s1');
  const echoes = await archiveEchoes(inst, id);
  assert.deepEqual(echoes.map(e => e.text), [RENEW_HEAD[1].message.content, 's1 big prompt'], 'fixture: both s1 echoes are archive-served');
  for (const e of echoes) assert.equal('userIndex' in e, false, `"${e.text}" carries no userIndex`);
});

test('an archive echo whose live ordinal would be negative carries no userIndex', async () => {
  // No s0 echo against the renew head's one prompt line: file = live + 1, so the
  // `/clear` line's live ordinal would be −1.
  const ids = chainIds();
  const { inst, id, crossed } = await bootLiveAcrossSeams({
    ctx, project: `p${boots}`, publicId: ids.s0.slice(0, 8), ringCap: RING_CAP,
    segments: [
      { id: ids.s0, reason: 'initial', records: [{ type: 'assistant', uuid: 's0-a', message: { id: 's0-m', role: 'assistant', content: [{ type: 'text', text: 's0 reply' }] } }] },
      { id: ids.s1, reason: 'renew', records: segmentTurns('s1', M) },
    ],
  });
  const live = liveStamps(crossed);
  assert.equal(live.get(0), 0, 'fixture: s0 contributed no echo');
  const echoes = await archiveEchoes(inst, id);
  const clear = echoes.find(e => e.text === RENEW_HEAD[1].message.content);
  assert.ok(clear, 'fixture: the /clear echo is archive-served');
  assert.equal('userIndex' in clear, false, 'the /clear echo carries no userIndex');
  const prompts = echoes.filter(e => S1_PROMPT.test(e.text));
  assert.ok(prompts.length > 0, 'fixture: some s1 prompt is archive-served');
  for (const e of prompts) assert.equal(e.userIndex, live.get(Number(S1_PROMPT.exec(e.text)[1])), `"${e.text}" carries its live stamp`);
});

test('a single-segment instance forks and rewinds with a ring the file cannot calibrate', async () => {
  // A live turn the file has not recorded, big enough that the trim evicted its
  // echo: nothing in the ring correlates into the file.
  const ids = chainIds();
  const { inst, id, place } = await bootLiveAcrossSeams({
    ctx, project: `p${boots}`, publicId: ids.s0.slice(0, 8), ringCap: RING_CAP,
    segments: [{ id: ids.s0, reason: 'initial', records: segmentTurns('s0', 3) }],
  });
  const file = sessionFilePath(place, ids.s0);
  emitLive(inst, { echo: 'unrecorded prompt', msgId: 'unrecorded', blocks: 12 });
  assert.deepEqual(inst.ring.seams.map(s => s.startSeq), [0], 'fixture: one segment');
  assert.ok(!inst.ringSnapshot().some(e => e.kind === 'user_echo'), 'fixture: the trim evicted every echo');
  const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1, text: 's0 prompt 1' });
  assert.equal(fk.status, 201, JSON.stringify(fk.body));
  assert.equal(fk.body.droppedText, 's0 prompt 1');
  const rw = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 1, text: 's0 prompt 1' });
  assert.equal(rw.status, 200, JSON.stringify(rw.body));
  assert.equal(rw.body.droppedText, 's0 prompt 1');
  assert.deepEqual(parseLines(await fs.readFile(file, 'utf8')).filter(r => r.uuid).map(r => r.uuid), ['s0-u0', 's0-a0']);
});

test('the offset is calibrated on the current segment\'s ring content only', async () => {
  // Untrimmed ring: the s0 echoes are still in it (trimmedBefore < the seam).
  // The first s1 ring content is a reply whose echo the ring never carried,
  // and the file holds a prompt the ring never echoed before the first s1
  // echo — so an s0 echo taken as the calibration echo gives a different
  // offset from the current segment's own first echo.
  const ids = chainIds();
  const s1 = [
    ...segmentTurns('s1', 1),
    { type: 'user', uuid: 's1-uX', message: { role: 'user', content: 's1 unechoed prompt' } },
    { type: 'assistant', uuid: 's1-aX', message: { id: 's1-mX', role: 'assistant', content: [{ type: 'text', text: 's1 unechoed reply' }] } },
    { type: 'user', uuid: 's1-u1', message: { role: 'user', content: 's1 prompt 1' } },
    { type: 'assistant', uuid: 's1-a1', message: { id: 's1-m1', role: 'assistant', content: [{ type: 'text', text: 's1 reply 1' }] } },
  ];
  const { inst, id, place } = await bootLiveAcrossSeams({
    ctx, project: `p${boots}`, publicId: ids.s0.slice(0, 8), ringCap: 1000,
    segments: [{ id: ids.s0, reason: 'initial', records: segmentTurns('s0', 2) }],
  });
  await fs.writeFile(sessionFilePath(place, ids.s1), [...RENEW_HEAD, ...s1].map(r => JSON.stringify(r)).join('\n') + '\n');
  await rotate(inst, ids.s1);
  await replaySlice(inst, place, ids.s1, { from: 1, to: 2 }); // s1 reply 0, without its echo
  await replaySlice(inst, place, ids.s1, { from: 4 });        // s1 prompt 1 + reply
  assert.ok(inst.ring.trimmedBefore < inst.ring.seams.at(-1).startSeq, 'fixture: the ring still holds s0');
  const echo = inst.ringSnapshot().find(e => e.kind === 'user_echo' && e.text === 's1 prompt 1');
  const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: echo.userIndex, text: echo.text });
  assert.equal(fk.status, 201, JSON.stringify(fk.body));
  assert.equal(fk.body.droppedText, 's1 prompt 1');
});
