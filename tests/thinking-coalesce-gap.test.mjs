// Storage-only coalescing of the ollama thinking flood, end-to-end through a
// real Instance + the archive/paging path (src/instances.js EventLog,
// src/eventArchive.js pageInstanceEvents). On ollama-backed workers the CLI
// emits one system/thinking_tokens per thinking_delta token; before the fix a
// single long reasoning turn overflowed the ring and left its head mid-turn,
// so get_transcript spliced a spurious {kind:'history_gap'} INSIDE the turn.
// The ring now keeps thinking_tokens out entirely and folds a block's deltas
// into one slot, so the turn's footprint is O(blocks), not O(tokens) — the
// boundary survives and no gap is produced. The LIVE per-token stream is
// unchanged (asserted here via the events emitted on the 'event' channel).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { pageInstanceEvents } from '../src/eventArchive.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

let ctx, home, prevCap;
before(async () => {
  // A tiny cap: the raw flood (hundreds of events) dwarfs it, so without
  // coalescing the single turn would evict its own boundary and gap. Read at
  // Instance construction, so set it before any instance is booted.
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
  await waitFor(() => ctx.instances.get(id).status === 'idle');
  return ctx.instances.get(id);
}

// Emit an ollama-style single reasoning turn: one thinking_tokens per
// thinking_delta token, interleaved 1:1 exactly as observed on glm-5.2:cloud.
function emitOllamaThinkingTurn(inst, { deltas }) {
  const live = [];
  // Snapshot each frame's fields AT EMIT TIME — exactly what wsHub does
  // (JSON.stringify synchronously in its 'event' listener). Stashing the raw
  // object and reading it later would observe the in-place text accumulation
  // of the ring slot, which the synchronous WS serialization never sees.
  inst.on('event', (ev) => live.push({ kind: ev.kind, subtype: ev.subtype, _seq: ev._seq, text: ev.text }));
  inst._emitUi({ kind: 'user_echo', text: 'reason hard' });
  inst._emitUi({ kind: 'thinking_start', msgId: 'm1', blockIdx: 0 });
  let running = 0;
  const parts = [];
  for (let i = 0; i < deltas; i++) {
    const text = `tok${i} `;
    parts.push(text);
    inst._emitUi({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text });
    running += 2;
    inst._emitUi({ kind: 'system', subtype: 'thinking_tokens',
      data: { estimated_tokens: running, estimated_tokens_delta: 2 } });
  }
  inst._emitUi({ kind: 'thinking_end', msgId: 'm1', blockIdx: 0 });
  inst._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 1, text: 'done' });
  inst._emitUi({ kind: 'text_end', msgId: 'm1', blockIdx: 1 });
  inst._emitUi({ kind: 'turn_end', subtype: 'success' });
  return { live, expectedThinking: parts.join('') };
}

test('an ollama thinking flood neither evicts nor produces a mid-turn history_gap', async () => {
  const inst = await bootIdle('ollamathink');
  const { expectedThinking } = emitOllamaThinkingTurn(inst, { deltas: 500 });

  const ring = inst.ringSnapshot();
  // 500 deltas + 500 thinking_tokens would be 1000+ events (>> cap 10). After
  // coalescing the whole turn is: echo, thinking_start, ONE thinking_delta,
  // thinking_end, text_delta, text_end, turn_end = 7 retained slots.
  assert.equal(ring.length, 7, `turn footprint is O(blocks), not O(tokens) (got ${ring.length})`);
  assert.equal(inst.ring.trimmedBefore, 0, 'nothing evicted → the turn boundary survives');
  assert.equal(ring[0].kind, 'user_echo');

  // Zero thinking_tokens retained; exactly one coalesced thinking_delta.
  assert.equal(ring.filter(e => e.kind === 'system' && e.subtype === 'thinking_tokens').length, 0);
  const deltas = ring.filter(e => e.kind === 'thinking_delta');
  assert.equal(deltas.length, 1, 'the block folded into a single ring slot');
  assert.equal(deltas[0].text, expectedThinking, 'coalesced text is the full concatenation');

  // The archive/paging path (what get_transcript serves) shows NO history_gap.
  const page = await pageInstanceEvents(inst, { limit: 500 });
  assert.ok(!page.events.some(e => e.kind === 'history_gap'),
    'no spurious mid-turn gap in the reconstructed transcript');
});

test('the live per-token stream is untouched (coalescing is storage-only)', async () => {
  const inst = await bootIdle('ollamalive');
  const { live, expectedThinking } = emitOllamaThinkingTurn(inst, { deltas: 50 });

  // Every per-token delta still reached the live 'event' feed — 50 of them,
  // in order — even though only one landed in the ring.
  const liveDeltas = live.filter(e => e.kind === 'thinking_delta');
  assert.equal(liveDeltas.length, 50, 'all per-token deltas streamed live');
  assert.equal(liveDeltas.map(e => e.text).join(''), expectedThinking);
  // Every thinking_tokens counter update streamed live too (drives the UI counter).
  assert.equal(live.filter(e => e.kind === 'system' && e.subtype === 'thinking_tokens').length, 50);

  // Folded/declined events carry no _seq — that is exactly what makes the
  // client render them unconditionally as seq-less live frames.
  const seqless = liveDeltas.filter(e => e._seq == null);
  assert.equal(seqless.length, 49, 'deltas 2..N are seq-less (folded into slot 1)');
  assert.ok(liveDeltas[0]._seq != null, 'the first delta of the block anchors the ring slot');
});
