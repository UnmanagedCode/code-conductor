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
import { replayPersistedLine } from '../src/transcript.ts';

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

test('B-2: a ring LEADING with assistant_message alone is skipped, not treated as a miss', async () => {
  // T16 above covers message_start + turn_end but never exercises
  // assistant_message as the ring's very first (and only preceding) event —
  // the third RING_ONLY_KINDS member. An assistant_message carries a msgId
  // but no numeric blockIdx, so if it were NOT skipped, correlationKey would
  // return null, correlateRingHead would abandon on the very first event
  // (never reaching the correlatable text_end below it), and the fallback
  // echo anchor would take over. Phase A makes this ring shape common: A1
  // emits an assistant_message per forwarded sub-agent envelope, so a trim
  // can readily land the head on exactly this kind.
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t16b';
    await writeJsonl(cwd, SID, textBlockLines());
    const ring = [
      { kind: 'assistant_message', msgId: 'mLive', message: { id: 'mLive', role: 'assistant', content: [] }, _seq: 58 },
      { kind: 'text_end', msgId: 'm0', blockIdx: 7, _seq: 60 },
    ];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
    assert.equal(arch.cut, 16, 'still correlates via the text_end below the leading assistant_message');
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

test('B-3: cutFromEchoAnchor with a negative anchor clamps to 0, not "no match found"', async () => {
  // The echo-anchor fallback's `anchor` goes negative exactly when the ring
  // head is mid-turn, its content was never persisted (a correlation miss),
  // AND there is no echo anywhere in the ring on the session's very FIRST
  // turn: anchor = (no firstEcho ? userEchoCount : ...) - 1 = 0 - 1 = -1.
  // cutFromEchoAnchor's `if (anchor < 0) return 0` must catch this — without
  // it, the scan's `seen` counter (starting at 0) never equals -1, so no
  // echo ever matches and the function falls through to its "archive has
  // fewer prompts than the anchor" branch, returning flat.length: the ENTIRE
  // archive, which the ring already covers (trimmedBefore is well above it
  // here), duplicating every event instead of serving none of it.
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/b3';
    await writeJsonl(cwd, SID, textBlockLines());
    const ring = [
      { kind: 'text_delta', msgId: 'mLive', blockIdx: 0, text: 'live', _seq: 5 },
    ];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 100, userEchoCount: 0 });
    assert.equal(arch.events.length, 25, 'flat archive: 1 echo + 12 blocks * 2 events');
    assert.equal(arch.cut, 0, 'anchor<0 clamps to 0 — nothing is safe to serve, not "serve everything"');
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

// ---------------------------------------------------------------------------
// Card 2026-0414: `correlateRingHead` returned on the first non-RING_ONLY_KINDS
// ring event, hit or miss, conflating "replay structurally never emits this
// kind" (a skip — keep looking) with "this event's content is genuinely absent
// from the archive" (a real abandon). The skip set listed three kinds; the ring
// retains ten replay never produces, so a head of any of the other seven forced
// the echo-ordinal fallback and discarded the whole turn body.
//
// Fixture below is the shared textBlockLines(): block 7's text_end sits at flat
// index 16. The two possible answers are far apart and independently pinned by
// T15 (correlated → cut 16, gap false) and T18 (echo-anchor fallback → cut 1,
// gap true), so the predicted values are not guesses.

// Independent oracle for correlationKey, re-implemented here on purpose:
// importing the implementation's own would let a mutation to it pass unnoticed.
const keyOf = ev => ev.kind === 'tool_result' && typeof ev.toolUseId === 'string'
  ? `tr ${ev.toolUseId}`
  : (typeof ev.msgId === 'string' && typeof ev.blockIdx === 'number'
      ? `${ev.kind} ${ev.msgId} ${ev.blockIdx}` : null);

// Criterion 5: the served archive slice and the ring must never both carry the
// same wire content. Applied to every row of tables A and B and to T24.
function assertNoDuplication(arch, ring, label) {
  const ringKeys = new Set(ring.map(keyOf).filter(k => k != null));
  for (const ev of arch.events.slice(0, arch.cut)) {
    const k = keyOf(ev);
    assert.ok(k == null || !ringKeys.has(k),
      `${label}: archive slice event ${k} is also in the ring — duplicated across the seam`);
  }
}

const RING_TAIL = { kind: 'text_end', msgId: 'm0', blockIdx: 7, _seq: 60 };

// Table A — head-kind invariance. Transcript, ring tail, trimmedBefore and
// userEchoCount are all held fixed; ONLY ring[0] varies. Every one of these
// kinds is emitted live but never by replayPersistedLine, so the head scan must
// step over it and correlate on the tail.
//
// PINS: a ring head of any kind replay cannot produce does not change the cut.
const SKIPPABLE_HEADS = [
  ['(none — tail only)', null],
  ['tool_use_input_delta', { kind: 'tool_use_input_delta', msgId: 'mLive', blockIdx: 3, toolUseId: 'tuLive', partialJson: '{"a"', _seq: 59 }],
  ['system[hook_pending]', { kind: 'system', subtype: 'hook_pending', _seq: 59 }],
  ['raw', { kind: 'raw', line: 'not json', _seq: 59 }],
  ['hook', { kind: 'hook', event: 'PreToolUse', _seq: 59 }],
  ['control_response', { kind: 'control_response', requestId: 'r1', ok: true, _seq: 59 }],
  ['permission_request', { kind: 'permission_request', toolUseId: 'tuP', _seq: 59 }],
  ['permission_resolved', { kind: 'permission_resolved', toolUseId: 'tuP', allow: true, _seq: 59 }],
  ['overage_message_queued', { kind: 'overage_message_queued', _seq: 59 }],
];

for (const [label, head] of SKIPPABLE_HEADS) {
  test(`T20[${label}]: a ring head of a kind replay never emits is skipped — the cut is invariant to it`, async () => {
    const r = await freshProjectsRoot();
    try {
      const cwd = '/fake/t20';
      await writeJsonl(cwd, SID, textBlockLines());
      const ring = head ? [head, RING_TAIL] : [RING_TAIL];
      const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
      assert.equal(arch.cut, 16, `head=${label}: must correlate on the tail's block-7 text_end`);
      assert.equal(arch.gap, false, `head=${label}: a correlated cut is an exact stitch — no gap`);
      assertNoDuplication(arch, ring, `head=${label}`);
    } finally {
      await rmrf(r.home);
    }
  });
}

// Table B — the anti-over-widening guard. These are NOT defect coverage: they
// pass both before and after the fix. They exist to go red if anyone widens the
// skip set past the audited ten. `tool_use_start` and the `thinking_*` family
// ARE emitted by replayPersistedLine (src/transcript.ts), so skipping past one
// would step over its archive twin and duplicate it; `text_delta` is the
// genuine abandon — a correlatable key that misses the index.
//
// PINS: an event replay CAN emit abandons correlation on a miss; it is never
// skipped.
const ABANDONING_HEADS = [
  ['text_delta', { kind: 'text_delta', msgId: 'mLive', blockIdx: 0, text: 'live', _seq: 59 }],
  ['tool_use_start', { kind: 'tool_use_start', msgId: 'mLive', blockIdx: 0, toolUseId: 'tuLive', name: 'Bash', _seq: 59 }],
  ['thinking_end', { kind: 'thinking_end', msgId: 'mLive', blockIdx: 0, _seq: 59 }],
];

for (const [label, head] of ABANDONING_HEADS) {
  test(`T21[${label}]: a replay-producible head that misses the archive abandons — it is not skipped`, async () => {
    const r = await freshProjectsRoot();
    try {
      const cwd = '/fake/t21';
      await writeJsonl(cwd, SID, textBlockLines());
      const ring = [head, RING_TAIL];
      const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
      assert.equal(arch.cut, 1, `head=${label}: must fall back to the echo anchor, not skip to the tail`);
      assert.equal(arch.gap, true, `head=${label}: the fallback path always marks a gap`);
      assertNoDuplication(arch, ring, `head=${label}`);
    } finally {
      await rmrf(r.home);
    }
  });
}

// The `system` carve-out's other direction. `soft_interrupted` is the ONE
// subtype replay emits, so a head with it may have an archive counterpart and
// must abandon. Its own fixture: inserting the interrupt line into the shared
// one would shift every index in T20/T21.
//
// PINS: `system` is skipped only when its subtype is not `soft_interrupted`.
test('T22: a system[soft_interrupted] head abandons — replay emits that one subtype', async () => {
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t22';
    const [prompt, assistant] = textBlockLines();
    // isInterruptMarkerContent (src/parser.ts) matches a LONE text block with
    // exactly this text, so replay emits system@1 and block 7's text_end moves
    // to 17. It adds no user_echo, so echo ordinals are unchanged.
    await writeJsonl(cwd, SID, [
      prompt,
      { type: 'user', uuid: 'ui', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      assistant,
    ]);
    const ring = [
      { kind: 'system', subtype: 'soft_interrupted', _seq: 59 },
      { kind: 'text_end', msgId: 'm0', blockIdx: 7, _seq: 60 },
    ];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
    assert.equal(arch.events[1].kind, 'system', 'fixture check: replay emits a system event at flat index 1');
    assert.equal(arch.events[17].kind, 'text_end', 'fixture check: block 7\'s text_end moved to flat index 17');
    assert.equal(arch.cut, 1, 'a soft_interrupted head may be in the archive — abandon, do not skip');
    assert.equal(arch.gap, true);
    // Concrete duplication exhibit: an unqualified `system` carve-out would cut
    // at 17 and hand the client the archive's system@1 while the ring serves it
    // too. correlationKey gives a system event no key, so the keyOf oracle
    // cannot see this one — assert on the kind directly.
    assert.ok(!arch.events.slice(0, arch.cut).some(ev => ev.kind === 'system'),
      'the served archive slice must not carry the system event the ring also serves');
  } finally {
    await rmrf(r.home);
  }
});

// A correlated hit at archive index 0. T15/T17/T20 all pin hits well above
// zero (16/27/16), so none of them can see the difference between "no hit" and
// "hit at index 0" — a falsy test in place of the null test reads both as -1.
// Reachable whenever the jsonl's first event-bearing line is an assistant
// message (a fork, a resume, a compaction continuation): flat[0] is then a
// text_delta the ring head can name directly. Fixture puts the echo AFTER that
// message so the fallback's answer (25) is far from the correlated one (0) and
// the two are distinguishable on the cut as well as on the gap.
//
// PINS: a ring head whose correlation key matches flat[0] yields cut === 0 and
// gap === false — index 0 is a hit, not a miss.
test('T24: a correlated hit at archive index 0 is a hit, not a miss', async () => {
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t24';
    const [prompt, assistant] = textBlockLines();
    await writeJsonl(cwd, SID, [
      assistant,
      prompt,
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'after' }] } },
    ]);
    const ring = [{ kind: 'text_delta', msgId: 'm0', blockIdx: 0, text: 'block 0', _seq: 60 }];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
    assert.equal(arch.events.length, 27, 'fixture check: 12 blocks * 2 + echo + 1 block * 2');
    assert.equal(arch.events[0].kind, 'text_delta', 'fixture check: flat[0] is the event the ring head names');
    assert.equal(arch.events[0].blockIdx, 0, 'fixture check: flat[0] is block 0');
    assert.equal(arch.events[24].kind, 'user_echo', 'fixture check: the only echo sits at 24, so the fallback would answer 25');
    assert.equal(arch.cut, 0, 'index 0 is a genuine correlator hit — serve nothing below the ring head, do not fall back');
    assert.equal(arch.gap, false, 'a correlated cut is an exact stitch — no gap, even at index 0');
    assertNoDuplication(arch, ring, 'T24');
  } finally {
    await rmrf(r.home);
  }
});

// The loop-exhaust exit. Every event in the ring is one replay never emits, so
// the scan skips all of them and runs off the end without ever computing a key.
// That must abandon to the echo fallback: the ring holds no content the archive
// can be stitched to, so the exact seam is unknowable and the served page owes
// the client a gap marker. Returning a cut here instead would withhold evicted
// history with NO gap marker — this card's original symptom wearing a different
// hat. The widened ten-member skip set makes an all-skipped ring MORE reachable
// than before, not less.
//
// PINS: a ring consisting solely of never-persisted events abandons to the echo
// fallback — both the fallback cut and gap === true.
test('T25: a ring of only never-persisted events abandons to the echo fallback', async () => {
  const r = await freshProjectsRoot();
  try {
    const cwd = '/fake/t25';
    await writeJsonl(cwd, SID, textBlockLines());
    // Spans the skip set and the system carve-out; not one of them can yield a
    // correlatable key, so the loop exhausts.
    const ring = [
      { kind: 'message_start', msgId: 'mLive', _seq: 57 },
      { kind: 'tool_use_input_delta', msgId: 'mLive', blockIdx: 2, toolUseId: 'tuLive', partialJson: '{"a"', _seq: 58 },
      { kind: 'system', subtype: 'hook_pending', _seq: 59 },
      { kind: 'overage_message_queued', _seq: 60 },
    ];
    const arch = await buildArchive({ cwd, sessionId: SID, ring, trimmedBefore: 60, userEchoCount: 1 });
    assert.equal(arch.events.length, 25, 'fixture check: 1 echo + 12 blocks * 2');
    assert.equal(arch.cut, 1, 'exhausting the scan falls back to the echo anchor (echo 0 + 1), not to a cut of its own');
    assert.equal(arch.gap, true, 'nothing correlated, so the seam is unknowable — the page MUST be marked as gapped');
    assertNoDuplication(arch, ring, 'T25');
  } finally {
    await rmrf(r.home);
  }
});

// Tripwire for the carve-out's soundness condition. `neverPersisted` in
// src/eventArchive.ts skips `system` at every subtype EXCEPT
// `soft_interrupted`, on the premise that replay emits exactly that one. If a
// second one is ever added, skipping it would silently duplicate it across the
// archive/ring seam — nothing else in the codebase would notice. This test is
// what makes that loud.
//
// PINS: the set of `system` subtypes the replay path can construct is exactly
// {soft_interrupted}.
test('T23: tripwire — replay constructs `system` for exactly one subtype', async () => {
  const srcDir = new URL('../src/', import.meta.url);
  const readWhole = async (url) => {
    const src = await fs.readFile(new URL(url, srcDir), 'utf8');
    assert.ok(src.length > 0, `extraction failed: ${url} is empty — the scan below would prove nothing`);
    return src;
  };
  const readBody = async (url, decl) => {
    const src = await readWhole(url);
    const start = src.indexOf(decl);
    assert.notEqual(start, -1, `extraction failed: ${decl} not found — the scan below would prove nothing`);
    // Top-level functions in this codebase close with `}` at column 0.
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, `extraction failed: no closing brace for ${decl}`);
    return src.slice(start, end);
  };

  // src/transcript.ts is scanned WHOLE, not narrowed to replayPersistedLine's
  // body: every function in that file is replay-side, so the scoping concern
  // that narrows the parser.ts scan does not apply, and a `system` built by a
  // helper elsewhere in the file — which a body-scoped scan would miss while
  // replay genuinely emitted the new subtype — is caught here. src/parser.ts
  // stays scoped to consolidateUserContent, the one replay-reachable event
  // constructor it owns; whole-file there would sweep up the LIVE parser's many
  // `system` sites, which say nothing about what replay emits.
  //
  // Residual limit, stated honestly: this catches a literal `kind: 'system'`
  // inside these two scopes. A construction in a non-literal form (a subtype
  // held in a variable, a kind spread in from an object) or in a third file
  // reached from the replay path still escapes both regexes. The positive
  // control below narrows that gap but does not close it.
  const bodies = [
    await readWhole('transcript.ts'),
    await readBody('parser.ts', 'export function consolidateUserContent('),
  ];

  let sites = 0;
  const found = [];
  for (const body of bodies) {
    sites += (body.match(/kind: 'system'/g) ?? []).length;
    for (const m of body.matchAll(/kind: 'system',\s*subtype: '([A-Za-z0-9_]+)'/g)) found.push(m[1]);
  }
  const subtypes = [...new Set(found)].sort();

  // Non-vacuity FIRST: a regex that silently matches nothing would make every
  // assertion below trivially true and this guard would be dead while green.
  assert.ok(sites > 0, 'scan found no `kind: \'system\'` construction in the replay path — the extraction or the regex broke, not the invariant');
  // Every site must be subtype-readable, or a new one could hide from the set
  // assertion below. Compares MATCH COUNT to site count, not unique-subtype
  // count: today's two sites legitimately share one subtype.
  assert.equal(found.length, sites, `scan found ${sites} \`system\` construction(s) in the replay path but only ${found.length} with an adjacent subtype — replay now builds a system event whose subtype this scan cannot read, so the set below no longer covers every site`);

  assert.deepEqual(subtypes, ['soft_interrupted'],
    `replay now emits a second \`system\` subtype (${subtypes.join(', ')}). \`neverPersisted\` in src/eventArchive.ts skips \`system\` at every subtype except \`soft_interrupted\` on the premise that this set is a singleton; that premise is now false and skipping the new subtype will duplicate it across the archive/ring seam. Narrow the carve-out.`);

  // Positive control: the scanned literal is the one actually emitted.
  const emitted = replayPersistedLine({
    type: 'user', uuid: 'uc',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].kind, 'system');
  assert.equal(emitted[0].subtype, 'soft_interrupted');
});
