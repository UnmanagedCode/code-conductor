// Storage-only coalescing of the per-token PROSE flood, end-to-end through a
// real Instance + the archive/paging path (src/instances.ts EventLog,
// src/eventArchive.ts pageInstanceEvents). Sibling of
// tests/thinking-coalesce-gap.test.mjs, which covers the same fold for
// thinking_delta; this file covers what is specific to text:
//   - the same "a single block must not evict its own turn boundary and gap"
//     invariant, for prose (one block was observed at 1265-2060 ring slots),
//   - the live per-token stream staying untouched (the typing effect),
//   - the ASYNC seam: unlike thinking, a text slot IS routinely paged mid-stream
//     (get_transcript on a running worker), so in-place growth across an await
//     gets pinned here rather than left to a comment,
//   - the documented get_transcript cursor consequence (docs/protocol.md): an
//     open block's slot is served once and never re-served, so nobody
//     "fixes" that into a same-_seq re-serve the client would silently drop.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { pageInstanceEvents } from '../src/eventArchive.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

let ctx, home, prevCap;
before(async () => {
  // A tiny cap: the raw flood dwarfs it, so without coalescing the single turn
  // would evict its own boundary and gap. Read at Instance construction, so set
  // it before any instance is booted.
  prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  ctx = await bootServer({ scenarioPath: SCENARIO });
});
after(async () => {
  await ctx.close();
  if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
  else process.env.ORCH_EVENT_RING_CAP = prevCap;
});
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

async function bootIdle(projectName) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: projectName });
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: projectName, mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const id = r.body.id;
  await waitFor(() => ctx.instances.get(id).status === 'idle' && ctx.instances.get(id).sessionId);
  return ctx.instances.get(id);
}

// One turn whose whole answer is a single unbroken prose block — the shape a
// backend that answers in one long block produces on every token.
function emitProseTurn(inst, { deltas }) {
  const live = [];
  // Snapshot each frame's fields AT EMIT TIME — exactly what wsHub does in its
  // synchronous 'event' listener. Stashing the raw object and reading it later
  // would observe the in-place text accumulation of the ring slot instead.
  inst.on('event', (ev) => live.push({ kind: ev.kind, _seq: ev._seq, text: ev.text }));
  inst._emitUi({ kind: 'user_echo', text: 'write me an essay' });
  const parts = [];
  for (let i = 0; i < deltas; i++) {
    const text = `w${i} `;
    parts.push(text);
    inst._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text });
  }
  inst._emitUi({ kind: 'text_end', msgId: 'm1', blockIdx: 0 });
  inst._emitUi({ kind: 'turn_end', subtype: 'success' });
  return { live, expectedText: parts.join('') };
}

test('a prose flood neither evicts nor produces a mid-turn history_gap', async () => {
  const inst = await bootIdle('prosegap');
  const { expectedText } = emitProseTurn(inst, { deltas: 1200 });

  const ring = inst.ringSnapshot();
  // 1200 raw deltas (>> cap 10). After coalescing the whole turn is:
  // echo, ONE text_delta, text_end, turn_end = 4 retained slots.
  assert.equal(ring.length, 4, `turn footprint is O(blocks), not O(tokens) (got ${ring.length})`);
  assert.equal(inst.ring.trimmedBefore, 0, 'nothing evicted → the turn boundary survives');
  assert.equal(ring[0].kind, 'user_echo');

  const deltas = ring.filter(e => e.kind === 'text_delta');
  assert.equal(deltas.length, 1, 'the block folded into a single ring slot');
  assert.equal(deltas[0].text, expectedText, 'coalesced text is the full concatenation');

  // The archive/paging path (what get_transcript serves) shows NO history_gap.
  const page = await pageInstanceEvents(inst, { limit: 500 });
  assert.ok(!page.events.some(e => e.kind === 'history_gap'),
    'no spurious mid-turn gap in the reconstructed transcript');
});

test('the live per-token prose stream is untouched (coalescing is storage-only)', async () => {
  const inst = await bootIdle('proselive');
  const { live, expectedText } = emitProseTurn(inst, { deltas: 50 });

  // Every per-token delta still reached the live 'event' feed — 50 of them, in
  // order — even though only one landed in the ring. This is the typing effect.
  const liveDeltas = live.filter(e => e.kind === 'text_delta');
  assert.equal(liveDeltas.length, 50, 'all per-token deltas streamed live');
  assert.equal(liveDeltas.map(e => e.text).join(''), expectedText);

  // Folded events carry no _seq — that is exactly what makes the client render
  // them unconditionally as seq-less live frames instead of deduping them away.
  const seqless = liveDeltas.filter(e => e._seq == null);
  assert.equal(seqless.length, 49, 'deltas 2..N are seq-less (folded into slot 1)');
  assert.ok(liveDeltas[0]._seq != null, 'the first delta of the block anchors the ring slot');
});

test('an open slot grown during an in-flight page is served once, at its original _seq', async () => {
  const inst = await bootIdle('prosegrow');
  // Trim the ring first (cap 10) so the page genuinely takes the ARCHIVE branch
  // — buildArchive awaits a real jsonl read, which is the only path on which
  // pageInstanceEvents actually suspends. Without this the function would run to
  // completion synchronously and the await window under test wouldn't exist.
  for (let i = 0; i < 30; i++) inst._emitUi({ kind: 'system', subtype: 'pad', data: { i } });
  inst._emitUi({ kind: 'user_echo', text: 'stream at me' });
  for (let i = 0; i < 5; i++) {
    inst._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: `before${i} ` });
  }
  assert.ok(inst.ring.trimmedBefore > 0, 'precondition: ring trimmed, so the archive read runs');
  assert.ok(inst.sessionId, 'precondition: a sessionId to replay from (needArchive is gated on it)');
  const slotSeq = inst.ringSnapshot().find(e => e.kind === 'text_delta')._seq;

  // Start the page WITHOUT awaiting: pageInstanceEvents takes a shallow
  // ringSnapshot() and then awaits, so the open slot keeps growing underneath
  // it — the exact window a mid-stream get_transcript opens.
  const pending = pageInstanceEvents(inst, { limit: 500 });
  for (let i = 0; i < 5; i++) {
    inst._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: `after${i} ` });
  }
  const page = await pending;

  const served = page.events.filter(e => e.kind === 'text_delta');
  assert.equal(served.length, 1, 'growth extends the one slot — it never duplicates it');
  assert.equal(served[0]._seq, slotSeq, 'the slot is never renumbered by growth');
  // Append-only: the served text is the full post-growth concatenation, and the
  // pre-await prefix is still intact at the front of it.
  const expected = [0, 1, 2, 3, 4].map(i => `before${i} `).join('')
    + [0, 1, 2, 3, 4].map(i => `after${i} `).join('');
  assert.equal(served[0].text, expected, 'append-only growth, no tearing across the await');
  assert.equal(inst.ringSnapshot().filter(e => e.kind === 'text_delta').length, 1,
    'the ring still holds exactly one slot for the block');
});

test('forward paging does not re-serve an open block\'s slot (documented cursor contract)', async () => {
  const inst = await bootIdle('prosecursor');
  inst._emitUi({ kind: 'user_echo', text: 'stream at me' });
  inst._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'first ' });
  const slotSeq = inst.ringSnapshot().find(e => e.kind === 'text_delta')._seq;

  // A poller that has consumed the slot advances its cursor past it (nextFrom =
  // last served _seq + 1, i.e. `after: slotSeq`). More of the SAME block then
  // streams in — it grows the slot in place, below the cursor.
  for (let i = 0; i < 20; i++) {
    inst._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: `more${i} ` });
  }
  const midBlock = await pageInstanceEvents(inst, { after: slotSeq, limit: 500 });
  assert.deepEqual(midBlock.events, [],
    'the growing slot is NOT re-served — polling does not show an open block grow');

  // Closing the block emits a fresh event, which the same cursor DOES serve —
  // but still not the slot itself. get_recent_messages is the in-flight path.
  inst._emitUi({ kind: 'text_end', msgId: 'm1', blockIdx: 0 });
  const afterClose = await pageInstanceEvents(inst, { after: slotSeq, limit: 500 });
  assert.deepEqual(afterClose.events.map(e => e.kind), ['text_end'],
    'the close advances the cursor; the slot is still never re-served');
});
