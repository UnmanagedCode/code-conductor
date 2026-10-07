// The model-switch ledger: a restart switch's transcript divider lives on the
// session record (sessionStore `modelSwitches`), not in the CLI's jsonl, and is
// spliced into every replay by loadPersistedTranscript → replayPersistedText.
// Each reader that serves a transcript must show it EXACTLY ONCE, AT ITS ANCHOR
// (after the anchor line, before any later turn); the message-shaped readers must
// not see it at all.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, seedSessionJsonl } from './helpers.mjs';
import { SwitchLauncher } from './switchLauncher.mjs';
import { addCustomModel, setTierBackend } from '../src/appSettings.ts';
import {
  parseSessionsDoc, serializeSessionsDoc, appendModelSwitch, getModelSwitchesForSegment,
  removeSessionRecords, setSessionMode, settleSessionWrites, sessionsFile,
} from '../src/sessionStore.ts';
import { recordRotation } from '../src/sessionLineage.ts';
import { replayPersistedText, loadPersistedTranscript } from '../src/transcript.ts';
import { buildArchive, pageInstanceEvents, pagePersistedEvents, loadStampedTranscript } from '../src/eventArchive.ts';
import { loadDiskSelection, mergeRecentWithDisk } from '../src/mcp/messageReconstruction.ts';
import { getTranscript } from '../src/mcp/handlers.ts';
import { localPlace, sessionFilePath } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const A = 'alpha:cloud';
const B = 'beta:cloud';

// One persisted turn per prompt: `u<i>` the prompt, `a<i>` the reply.
function turns(from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    out.push({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `prompt ${i}` } });
    out.push({ type: 'assistant', uuid: `a${i}`, message: { id: `m${i}`, role: 'assistant', model: A, content: [{ type: 'text', text: `reply ${i}` }] } });
  }
  return out;
}
const jsonl = (records) => records.map(r => JSON.stringify(r)).join('\n') + '\n';

const entry = (over = {}) => ({ id: randomUUID(), at: '2026-01-01T00:00:00.000Z', segment: 'seg', afterUuid: 'a0', from: A, to: B, ok: true, ...over });
const isDivider = (e) => e.kind === 'system' && (e.subtype === 'model_switch_failed' || (e.subtype === 'model_changed' && e.data?.restart));
const dividers = (evs) => evs.filter(isDivider);
const echoIdx = (evs, text) => evs.findIndex(e => e.kind === 'user_echo' && e.text === text);
const replyIdx = (evs, text) => evs.findLastIndex(e => typeof e.text === 'string' && e.kind !== 'user_echo' && e.text.includes(text));

// Exactly one divider, after the anchor turn's reply and before the next prompt.
function assertAtAnchor(evs, { after, before: next, label }) {
  const d = dividers(evs);
  assert.equal(d.length, 1, `${label}: exactly one divider (got ${d.length})`);
  const at = evs.indexOf(d[0]);
  const anchor = replyIdx(evs, after);
  assert.ok(anchor >= 0, `${label}: fixture check — the anchor reply is present`);
  assert.ok(at > anchor, `${label}: after the anchor line`);
  if (next) {
    const nextAt = echoIdx(evs, next);
    assert.ok(nextAt >= 0, `${label}: fixture check — the later prompt is present`);
    assert.ok(at < nextAt, `${label}: before the later turn`);
  }
  return d[0];
}

// ── live readers ────────────────────────────────────────────────────────────

let ctx, baseUrl, wsUrl, instances, launcher, home;

function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.once('open', () => resolve({
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 8000) { return waitFor(() => messages.find(predicate), { timeout }); },
    }));
    ws.once('error', reject);
  });
}

async function snapshotOf(id) {
  const c = await wsClient(wsUrl);
  try {
    c.send({ t: 'subscribe', id });
    return (await c.wait(m => m.t === 'snapshot' && m.id === id)).events;
  } finally { await c.close(); }
}

// A substitution session on A with one persisted turn (u0/a0), switched to B —
// confirmed (`ok`) or crashed in the grace window and re-resumed on A.
async function switched(ok) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: A, backend: 'ollama' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  inst._modelSwitchGraceMs = 30;
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId, turns(0, 1));
  if (!ok) launcher.plan.push({ crash: 'no such model' });
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await inst._modelSwitchRun;
  assert.equal(inst.model, ok ? B : A, 'fixture check: the switch landed as intended');
  return inst;
}

// The later turn, as the CLI would append it after the switch.
async function appendTurn(inst, from, to) {
  await fs.appendFile(sessionFilePath(inst.transcriptPlace, inst.backingSessionId), jsonl(turns(from, to)));
}

// Every test, the pure ones included, gets a fresh store root here.
before(async () => {
  launcher = new SwitchLauncher();
  ctx = await bootServer({ scenarioPath: SCENARIO, claudeLauncher: launcher });
  ({ baseUrl, wsUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home } = await freshProjectsRoot());
  launcher.plan = [];
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  await addCustomModel({ label: 'Alpha', model: A, backend: 'ollama', contextWindow: 100_000 });
  await addCustomModel({ label: 'Beta', model: B, backend: 'ollama', contextWindow: 300_000 });
  await setTierBackend('fast', { backend: 'ollama', model: A });
  await setTierBackend('balanced', { backend: 'ollama', model: B });
});
afterEach(async () => { await instances.shutdown(); await settleSessionWrites(); await rmrf(home); });

// ── pure: the store and the splice ──────────────────────────────────────────

test('L1: the ledger round-trips through the sessions doc, drops invalid entries, and leaves with its record', async () => {
  const good = entry({ id: 'e1', afterUuid: null, ok: false, error: 'boom' });
  const doc = parseSessionsDoc({ sessions: {
    s1: { current: 's1', segments: [{ id: 's1', reason: 'initial', at: '' }], modelSwitches: [
      good,
      { ...entry({ id: 'e2' }), ok: 'yes' },        // ok must be boolean
      { ...entry({ id: 'e3' }), afterUuid: 7 },      // anchor must be a string or null
      { ...entry({ id: 'e4' }), segment: '' },       // segment required
    ] },
    s2: { current: 's2', segments: [{ id: 's2', reason: 'initial', at: '' }] },
  } });
  assert.deepEqual(doc.get('s1').modelSwitches, [good]);
  assert.equal(doc.get('s2').modelSwitches, undefined, 'a record without the field parses with none');
  const again = parseSessionsDoc(JSON.parse(serializeSessionsDoc(doc)));
  assert.deepEqual(again.get('s1').modelSwitches, [good], 'serialize → parse is lossless');
  assert.ok(!('modelSwitches' in JSON.parse(serializeSessionsDoc(doc)).sessions.s2), 'none serializes as absent');

  const sid = randomUUID();
  await setSessionMode(sid, 'plan');
  const mine = entry({ segment: sid });
  await appendModelSwitch(sid, mine);
  await appendModelSwitch(sid, entry({ segment: 'other-segment' }));
  assert.deepEqual(await getModelSwitchesForSegment(sid), [mine], 'filtered to the asked segment');
  await removeSessionRecords(() => [sid], { snapshotFile: path.join(home, 'snap.json') });
  assert.deepEqual(await getModelSwitchesForSegment(sid), [], 'gone with its record');
});

test('L2: replayPersistedText splices each entry at its anchor without touching the counts', async () => {
  const place = localPlace('/fake/l2');
  const text = jsonl(turns(0, 3));
  const plain = await replayPersistedText({ place, sessionId: 's', text });
  const lead = entry({ afterUuid: null, to: 'lead' });
  const mid = entry({ afterUuid: 'a1', to: 'mid' });
  const lost = entry({ afterUuid: 'never-written', to: 'lost' });
  const spliced = await replayPersistedText({ place, sessionId: 's', text, modelSwitches: [lost, mid, lead] });
  const flat = spliced.lines.flatMap(l => l.events);
  const order = dividers(flat).map(d => d.data.to);
  assert.deepEqual(order, ['lead', 'mid', 'lost'], 'null anchor first, matched in place, unmatched at the end');
  assert.equal(flat[0].data.to, 'lead');
  const midAt = flat.findIndex(e => e.data?.to === 'mid');
  assert.ok(midAt > replyIdx(flat, 'reply 1') && midAt < echoIdx(flat, 'prompt 2'));
  assert.equal(flat.at(-1).data.to, 'lost');
  assert.ok(flat.filter(isDivider).every(d => d.replayed === true && typeof d.data.switchId === 'string'));
  assert.equal(spliced.replayedCount, plain.replayedCount, 'splice lines are not replayed lines');
  assert.equal(spliced.lastLeafUuid, plain.lastLeafUuid);
  assert.equal(spliced.lines.length, plain.lines.length + 3);
});

for (const ok of [true, false]) {
  const kind = ok ? 'success divider' : 'failure divider (L10)';

  test(`L3: R1 after a page reload — the snapshot holds the ${kind} once, at its anchor`, async () => {
    const inst = await switched(ok);
    const ring = inst.ringSnapshot();
    assert.equal(dividers(ring).length, 1, 'fixture check: in the ring once');
    const d = assertAtAnchor(await snapshotOf(inst.id), { after: 'reply 0', label: 'reload' });
    assert.equal(d.subtype, ok ? 'model_changed' : 'model_switch_failed');
  });

  test(`L4: R1 after another relaunch — the respawned ring holds the ${kind} once, before the later turns`, async () => {
    const inst = await switched(ok);
    await appendTurn(inst, 1, 3);
    await inst.kill();
    await instances.respawn(inst.id);
    await waitFor(() => inst.status === 'idle');
    assertAtAnchor(inst.ringSnapshot(), { after: 'reply 0', before: 'prompt 1', label: 'respawn ring' });
    assertAtAnchor(await snapshotOf(inst.id), { after: 'reply 0', before: 'prompt 1', label: 'respawn snapshot' });
  });

  test(`L5: R1 after a cold resume (the cc-restart path) — snapshot and REST events hold the ${kind} once`, async () => {
    const inst = await switched(ok);
    await appendTurn(inst, 1, 2);
    const { sessionId } = inst;
    await inst.kill();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', resume: sessionId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const fresh = instances.get(r.body.id);
    assert.notEqual(fresh, inst, 'fixture check: a new Instance object, as after a restart');
    await waitFor(() => fresh.status === 'idle');
    assertAtAnchor(await snapshotOf(fresh.id), { after: 'reply 0', before: 'prompt 1', label: 'resume snapshot' });
    const rest = await api(baseUrl, 'GET', `/api/instances/${fresh.id}/events?limit=500`);
    assert.equal(rest.status, 200);
    assertAtAnchor(rest.body.events, { after: 'reply 0', before: 'prompt 1', label: 'REST events' });
  });
}

test('L6: R2 after ring eviction — the archive serves the divider once across the cut', async () => {
  const inst = await switched(true);
  await appendTurn(inst, 1, 12);
  const { sessionId } = inst;
  await inst.kill();
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '6';
  let fresh;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', resume: sessionId });
    fresh = instances.get(r.body.id);
  } finally {
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP; else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
  await waitFor(() => fresh.status === 'idle');
  assert.ok(fresh.ring.trimmedBefore > 0, 'fixture check: the divider\'s turn was evicted from the ring');
  assert.equal(dividers(fresh.ringSnapshot()).length, 0, 'fixture check: only the archive can serve it');
  const page = await pageInstanceEvents(fresh, { limit: 500 });
  assertAtAnchor(page.events, { after: 'reply 0', before: 'prompt 1', label: 'archive + ring' });
});

test('L6b: a divider at the ring head correlates into the archive by its switchId — exact cut, no gap', async () => {
  const sid = randomUUID();
  const place = localPlace('/fake/l6b');
  await seedSessionJsonl(place, sid, turns(0, 3));
  await setSessionMode(sid, 'plan');
  const e = entry({ segment: sid, afterUuid: 'a0' });
  await appendModelSwitch(sid, e);
  const flat = await loadStampedTranscript({ place, sessionId: sid });
  const d = flat.findIndex(isDivider);
  assert.ok(d > 0, 'fixture check: the archive holds the divider');
  // The ring kept the divider and everything after it; everything before was evicted.
  const ring = flat.slice(d).map((ev, i) => ({ ...ev, _seq: 100 + i }));
  const arch = await buildArchive({ place, sessionId: sid, ring, trimmedBefore: 100, userEchoCount: 3 });
  assert.equal(arch.cut, d, 'archive serves exactly what precedes the divider');
  assert.equal(arch.gap, false);
});

test('L6c: a FAILURE divider at the ring head is persisted too — exact cut on it, no duplicate, no gap', async () => {
  const sid = randomUUID();
  const place = localPlace('/fake/l6c');
  await seedSessionJsonl(place, sid, turns(0, 3));
  await setSessionMode(sid, 'plan');
  await appendModelSwitch(sid, entry({ segment: sid, afterUuid: 'a0', ok: false, error: 'boom' }));
  const flat = await loadStampedTranscript({ place, sessionId: sid });
  const d = flat.findIndex(isDivider);
  assert.equal(flat[d]?.subtype, 'model_switch_failed', 'fixture check: the archive holds the failure divider');
  const ring = flat.slice(d).map((ev, i) => ({ ...ev, _seq: 100 + i }));
  const arch = await buildArchive({ place, sessionId: sid, ring, trimmedBefore: 100, userEchoCount: 3 });
  assert.equal(arch.cut, d, 'archive serves exactly what precedes the failure divider');
  assert.equal(arch.gap, false);
  assert.equal(dividers(arch.events.slice(0, arch.cut)).length, 0, 'not served twice');
});

test('L7: R3 get_transcript — disk (not live) and live both include the divider once', async () => {
  const inst = await switched(true);
  await appendTurn(inst, 1, 2);
  const live = await getTranscript({ sessionId: inst.sessionId, limit: 500 }, { instances });
  assert.equal(live.source, 'ring');
  assertAtAnchor(live.events, { after: 'reply 0', label: 'live get_transcript' });
  const { sessionId, backingSessionId, transcriptPlace } = inst;
  await instances.shutdown();
  const disk = await getTranscript({ sessionId, limit: 500 }, { instances });
  assert.equal(disk.source, 'disk', 'fixture check: served off disk');
  assertAtAnchor(disk.events, { after: 'reply 0', before: 'prompt 1', label: 'disk get_transcript' });
  const page = await pagePersistedEvents({ place: transcriptPlace, sessionId: backingSessionId, limit: 500 });
  assertAtAnchor(page.events, { after: 'reply 0', before: 'prompt 1', label: 'pagePersistedEvents' });
});

test('L8: R4 an older segment\'s lineage read carries its own divider, the current one does not', async () => {
  const s1 = randomUUID();
  const s2 = randomUUID();
  const place = localPlace('/fake/l8');
  await seedSessionJsonl(place, s1, turns(0, 2));
  await seedSessionJsonl(place, s2, turns(2, 3));
  await recordRotation(s1, s2, 'prune');
  await appendModelSwitch(s1, entry({ segment: s1, afterUuid: 'a0', to: 'old' }));
  const old = await loadStampedTranscript({ place, sessionId: s1 });
  const d = assertAtAnchor(old, { after: 'reply 0', before: 'prompt 1', label: 'older segment' });
  assert.equal(d.data.to, 'old');
  assert.equal(dividers(await loadStampedTranscript({ place, sessionId: s2 })).length, 0, 'not on the current segment');
});

test('L9: R5 the message readers ignore the divider — get_recent_messages is unchanged by it', async () => {
  const sid = randomUUID();
  const place = localPlace('/fake/l9');
  await seedSessionJsonl(place, sid, turns(0, 3));
  await setSessionMode(sid, 'plan');
  const fake = { transcriptPlace: place, backingSessionId: sid };
  const without = [await loadDiskSelection({ place, backingSessionId: sid, includeThinking: false }),
    await mergeRecentWithDisk(fake, [], false)];
  await appendModelSwitch(sid, entry({ segment: sid, afterUuid: 'a1' }));
  const replay = await loadPersistedTranscript({ place, sessionId: sid });
  assert.equal(dividers(replay.lines.flatMap(l => l.events)).length, 1, 'fixture check: the reader\'s input carries it');
  const withIt = [await loadDiskSelection({ place, backingSessionId: sid, includeThinking: false }),
    await mergeRecentWithDisk(fake, [], false)];
  assert.ok(without[0].messages.length > 0, 'fixture check: there are messages to compare');
  assert.deepEqual(withIt[0].messages, without[0].messages, 'loadDiskSelection: no phantom message');
  assert.deepEqual(withIt[1], without[1], 'mergeRecentWithDisk: no phantom message');
});

test('L11: a rewind past the anchor moves the divider to the cut, ahead of the turns that follow', async () => {
  const inst = await switched(true);
  // The session ran two more turns after the switch, the divider sitting after the second.
  await appendTurn(inst, 1, 3);
  const { sessionId, backingSessionId } = inst;
  await appendModelSwitch(sessionId, entry({ segment: backingSessionId, afterUuid: 'a2', to: 'late' }));
  // Another segment's entry on the same record, anchored to a uuid this rewind
  // does not keep: it is not this transcript's, so it must not move.
  const foreign = entry({ segment: 'another-segment', afterUuid: 'a2', to: 'foreign' });
  await appendModelSwitch(sessionId, foreign);
  await inst.kill();
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', resume: sessionId });
  const fresh = instances.get(r.body.id);
  await waitFor(() => fresh.status === 'idle');
  // Prompt ordinal 2 is `prompt 2`: the rewind drops u2/a2 and so the late anchor.
  await fresh.rewindToUserMessage(2, 'prompt 2');
  const ledger = await getModelSwitchesForSegment(backingSessionId);
  assert.deepEqual(ledger.map(e => [e.to, e.afterUuid]), [[B, 'a0'], ['late', 'a1']], 'only the truncated anchor moved, to the last surviving line');
  const record = JSON.parse(await fs.readFile(sessionsFile(), 'utf8')).sessions[sessionId];
  assert.deepEqual(record.modelSwitches.find(e => e.id === foreign.id), foreign, 'another segment\'s entry is untouched');
  await appendTurn(fresh, 3, 4);
  const replay = (await loadPersistedTranscript({ place: fresh.transcriptPlace, sessionId: backingSessionId })).lines.flatMap(l => l.events);
  const late = replay.findIndex(e => isDivider(e) && e.data.to === 'late');
  assert.ok(late > replyIdx(replay, 'reply 1'), 'after the cut');
  assert.ok(late < echoIdx(replay, 'prompt 3'), 'before the turn that followed the rewind');
});

// ── a ring NOT rebuilt by a replay (launch({}) after a wipe) ────────────────
//
// The archive leads with the segment's null-anchored dividers; the ring has to
// lead with them too, or the two seq spaces drift by one: the echo-anchored cut
// overshoots the ring floor, a `history_gap` is marked and an event is dropped.
// The later turns are emitted LIVE with exactly the events their replay yields
// (and the matching lines are appended to the jsonl), so ring and file hold the
// same content and only the leading divider can tell them apart.

const sig = (e) => [e.kind, e.subtype ?? '', e.text ?? '', e.msgId ?? '', e.blockIdx ?? '', e.data?.switchId ?? ''].join('|');

async function liveTurns(inst, from, to) {
  const records = turns(from, to);
  const { lines } = await replayPersistedText({ place: inst.transcriptPlace, sessionId: inst.backingSessionId, text: jsonl(records) });
  for (const ev of lines.flatMap(l => l.events)) inst._emitUi({ ...ev });
  const file = sessionFilePath(inst.transcriptPlace, inst.backingSessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, jsonl(records));
}

async function withRingCap(cap, fn) {
  const prev = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = String(cap);
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.ORCH_EVENT_RING_CAP; else process.env.ORCH_EVENT_RING_CAP = prev; }
}

async function assertRingAgreesWithArchive(inst, label) {
  assert.ok(inst.ring.trimmedBefore > 0, `${label}: fixture check — the ring was trimmed, so the archive is in play`);
  const arch = await buildArchive({ place: inst.transcriptPlace, sessionId: inst.backingSessionId,
    ring: inst.ringSnapshot(), trimmedBefore: inst.ring.trimmedBefore, userEchoCount: inst._userEchoCount });
  assert.equal(arch.gap, false, `${label}: no false history_gap`);
  const page = await pageInstanceEvents(inst, { limit: 1000 });
  const served = page.events.filter(e => e.kind !== 'segment_seam');
  assert.equal(served.filter(e => e.kind === 'history_gap').length, 0, `${label}: no gap marker served`);
  assert.equal(dividers(served).length, 1, `${label}: the divider exactly once`);
  const flat = await loadStampedTranscript({ place: inst.transcriptPlace, sessionId: inst.backingSessionId });
  assert.deepEqual(served.map(sig), flat.map(sig), `${label}: archive + ring serve the transcript whole, nothing lost at the cut`);
}

test('L12: a rewind to the first prompt seeds its null-anchored divider into the ring — ring and archive agree', async () => {
  const inst = await switched(true);
  const { sessionId, backingSessionId } = inst;
  await inst.kill();
  const fresh = await withRingCap(6, async () => {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', resume: sessionId });
    return instances.get(r.body.id);
  });
  await waitFor(() => fresh.status === 'idle');
  await fresh.rewindToUserMessage(0, 'prompt 0');
  assert.deepEqual((await getModelSwitchesForSegment(backingSessionId)).map(e => e.afterUuid), [null],
    'fixture check: the rewind left the divider null-anchored');
  await waitFor(() => fresh.status === 'idle');
  const ring = fresh.ringSnapshot();
  assert.equal(dividers(ring).length, 1, 'in the live conversation right after the relaunch');
  assert.equal(ring.indexOf(dividers(ring)[0]), 0, 'leading, as the archive has it');
  await liveTurns(fresh, 1, 9);
  await assertRingAgreesWithArchive(fresh, 'rewind to first');
});

test('L13: a failed no-turn switch\'s re-resume seeds its divider into the ring — ring and archive agree', async () => {
  const inst = await withRingCap(6, async () => {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: A, backend: 'ollama' });
    return instances.get(r.body.id);
  });
  await waitFor(() => inst.status === 'idle');
  inst._modelSwitchGraceMs = 30;
  launcher.plan.push({ crash: 'no such model' });
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await inst._modelSwitchRun;
  assert.equal(inst.model, A, 'fixture check: the switch failed');
  assert.deepEqual((await getModelSwitchesForSegment(inst.backingSessionId)).map(e => [e.ok, e.afterUuid]), [[false, null]]);
  const ring = inst.ringSnapshot();
  assert.equal(dividers(ring).length, 1, 'in the live conversation right after the re-resume');
  assert.equal(ring.indexOf(dividers(ring)[0]), 0);
  await liveTurns(inst, 0, 8);
  await assertRingAgreesWithArchive(inst, 'failed no-turn switch');
});
