// Phase B (card 2026-0146): buildArchive's mid-turn branch correlates the
// ring head into the replayed archive by content — (kind, msgId, blockIdx)
// or a tool_result's toolUseId — instead of anchoring on the echo ordinal,
// which used to collapse almost all reconstructible history on a session
// with few outer prompts and one long turn. The echo anchor stays as the
// fallback for when no correlator resolves.
//
// Pure unit tests over buildArchive: no server, no instance — just a real
// jsonl on disk (buildArchive replays through loadPersistedTranscript,
// which reads via sessionFilePath) and a hand-built stub ring, the same
// pattern as the buildArchive probes in tests/events-endpoint.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { sessionFilePath } from '../src/projects.ts';
import { buildArchive } from '../src/eventArchive.ts';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

async function writeJsonl(cwd, sessionId, lines) {
  const file = sessionFilePath(cwd, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

// One prompt + one assistant message with 12 text blocks. Replay produces
// user_echo(0), then per block i: text_delta(1+2i), text_end(2+2i) — so
// block 7's text_end sits at flat index 16. Shared by T15/T16/T18/T19.
function textBlockLines() {
  const blocks = Array.from({ length: 12 }, (_, i) => ({ type: 'text', text: `block ${i}` }));
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'prompt 0' } },
    { type: 'assistant', uuid: 'a0', message: { id: 'm0', role: 'assistant', content: blocks } },
  ];
}

test('T15: a mid-turn head is correlated by content', async () => {
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t15';
    await writeJsonl(cwd, SID, textBlockLines());
    // Ring head names the archive's block-7 text_end by content.
    // trimmedBefore:60 is deliberately NOT the archive index (16) — the two
    // seq spaces are non-identity, so a test that happened to compute its
    // expectation the same way the implementation does would pin nothing.
    const ring = [{ kind: 'text_end', msgId: 'm0', blockIdx: 7, _seq: 60 }];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
    assert.equal(arch.events.length, 25, 'flat archive: 1 echo + 12 blocks * 2 events');
    assert.equal(arch.cut, 16, 'cut lands exactly on block 7\'s text_end, correlated by content');
    assert.equal(arch.gap, false, 'a correlated cut is an exact stitch — no gap');
  } finally {
    await rmrf(r.home);
  }
});

test('T16: replay-absent kinds (message_start/turn_end/assistant_message) are skipped, not treated as a miss', async () => {
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t16';
    await writeJsonl(cwd, SID, textBlockLines());
    // The ring's own head is a message_start/turn_end pair the CLI never
    // persists — replay can't produce them, so correlating them directly
    // would always miss. The walk must skip past them to the next event.
    const ring = [
      { kind: 'message_start', msgId: 'mLive', _seq: 58 },
      { kind: 'turn_end', _seq: 59 },
      { kind: 'text_end', msgId: 'm0', blockIdx: 7, _seq: 60 },
    ];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
    assert.equal(arch.cut, 16, 'still correlates via the first replay-producible ring event');
    assert.equal(arch.gap, false);
  } finally {
    await rmrf(r.home);
  }
});

test('T17: a tool_result head correlates by toolUseId', async () => {
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t17';
    await writeJsonl(cwd, SID, [
      ...textBlockLines(),
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} },
      ] } },
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'done', is_error: false },
      ] } },
    ]);
    const ring = [{ kind: 'tool_result', toolUseId: 'tu1', content: 'done', isError: false, _seq: 70 }];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 70, userEchoCount: 1 });
    assert.equal(arch.events.length, 28, 'flat archive: 25 (T15 shape) + tool_use_start + tool_use + tool_result');
    assert.equal(arch.cut, 27, 'cut lands on the tool_result, correlated by toolUseId, not by msgId/blockIdx');
    assert.equal(arch.gap, false);
  } finally {
    await rmrf(r.home);
  }
});

test('T18: a miss abandons correlation outright — it does not keep scanning the ring', async () => {
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t18';
    await writeJsonl(cwd, SID, textBlockLines());
    // ring[0] names content NEVER persisted (foreign msgId) — the walk must
    // abandon right there rather than skipping ahead to ring[1], which WOULD
    // correlate (same block-7 text_end as T15/T16).
    const ring = [
      { kind: 'text_delta', msgId: 'mLive', blockIdx: 0, text: 'live', _seq: 59 },
      { kind: 'text_end', msgId: 'm0', blockIdx: 7, _seq: 60 },
    ];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
    // Fallback echo anchor: userEchoCount(1) - 1 = anchor 0, includeAnchorEcho
    // true → cut = the 0th echo's index (0) + 1 = 1.
    assert.equal(arch.cut, 1, 'falls back to the echo-ordinal anchor, not the ring[1] correlator hit');
    assert.equal(arch.gap, true, 'the fallback path always marks a gap');
  } finally {
    await rmrf(r.home);
  }
});

test('T19: the trimmedBefore clamp stays strict — cut === trimmedBefore is healthy, not a gap', async () => {
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t19';
    await writeJsonl(cwd, SID, textBlockLines());
    const ring = [{ kind: 'text_end', msgId: 'm0', blockIdx: 7, _seq: 60 }];
    // cut (16) === trimmedBefore (16): the healthy, turn-aligned case.
    const healthy = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 16, userEchoCount: 1 });
    assert.equal(healthy.cut, 16);
    assert.equal(healthy.gap, false, 'cut === trimmedBefore must NOT mark a spurious gap');
    // cut (16) > trimmedBefore (10): the clamp genuinely discards content.
    const clamped = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 10, userEchoCount: 1 });
    assert.equal(clamped.cut, 10);
    assert.equal(clamped.gap, true, 'cut > trimmedBefore is a real, markable loss');
  } finally {
    await rmrf(r.home);
  }
});
