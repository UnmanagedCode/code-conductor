// Non-Claude token usage end to end: an Instance driven by real substitution-
// backend captures, collecting the `turn_end` events its enrichment block
// stamps with `cacheEstimate` (src/cacheEstimate.ts).
//
// Fixtures (tests/fixtures/), each a trimmed real capture. The scrub keeps the
// init frame's model + claude_code_version (session_id rewritten, cwd set to
// /workspace/project), every stream_event frame except content_block_delta, and
// every assistant / user / result frame; it drops other system frames,
// signatures, uuids, request ids and timestamps; empties text, thinking and
// redacted-thinking bodies and tool_use inputs; replaces tool-result bodies and
// user prompts with a placeholder; and keeps the openrouter `cost` / `is_byok` /
// `cost_details` keys with their values nulled. Transcript excerpts keep user / assistant
// lines only, with synthetic uuid / parentUuid chains.
//   - nonclaude-ollama-v4-nocache.stdout.jsonl: ollama deepseek-v4-flash:cloud,
//     one call, a backend that never reports a cache read.
//   - nonclaude-ollama-v41.stdout.jsonl: ollama deepseek-v4.1-flash:cloud, three
//     turns / nine calls, a backend that reports its cache read on every
//     message_delta.
//   - nonclaude-ollama-v41.derived-nocache.stdout.jsonl: DERIVED from the
//     capture above (its line 1 is a `_fixture` note naming the transform):
//     every message_delta's cache_read_input_tokens folded into input_tokens
//     and the key deleted, and each result.usage's folded in and set to 0 —
//     the never-reports-cache shape, with the real twin as ground truth.
//   - nonclaude-ollama-v41.derived-nocache.transcript.jsonl: DERIVED from the
//     same session's persisted transcript (not from the stdout capture), through
//     turn 2: on every assistant line, the usage's cache_read_input_tokens folded
//     into input_tokens and the key deleted. Its line 1 is a `_fixture` note.
//   - nonclaude-openrouter.stdout.jsonl + nonclaude-openrouter.transcript.jsonl:
//     an Anthropic-compatible openrouter backend, one turn / two calls, whose
//     message_start usage is all zero and whose message_delta and persisted
//     assistant lines carry the real usage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Instance } from '../src/instances.ts';
import { promptTokenSum } from '../src/parser.ts';
import { mkdtemp } from './tmpRegistry.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function fixture(name) {
  const raw = await fs.readFile(path.join(FIXTURES, name), 'utf8');
  return raw.split('\n').filter(Boolean).filter(l => JSON.parse(l).type !== '_fixture');
}

async function makeInstance(t, { backend, model, place = null }) {
  const cwd = await mkdtemp('cc-nonclaude-usage-');
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const inst = new Instance({
    id: 'inst-nc', project: 'demo', cwd, mode: 'bypassPermissions',
    effort: 'medium', thinking: 'medium', model, ...(place ? { transcriptPlace: place } : {}),
  });
  // A user-defined backend id is not in the registry the constructor checks;
  // only `!== claude` matters to the path under test.
  inst.backend = backend;
  const turnEnds = [];
  inst.on('event', (ev) => { if (ev.kind === 'turn_end') turnEnds.push(ev); });
  return { inst, turnEnds };
}

function drive(inst, lines) {
  for (const l of lines) inst._handleStdoutLine(l);
}

const results = (lines) => lines.map(l => JSON.parse(l)).filter(o => o.type === 'result');

// (a) A single call on a never-reports-cache backend has no baseline: the turn
// is re-split with nothing cached, and flagged as estimated.
test('a never-reports-cache capture: its one call estimates 0 cached', async (t) => {
  const lines = await fixture('nonclaude-ollama-v4-nocache.stdout.jsonl');
  const { inst, turnEnds } = await makeInstance(t, { backend: 'ollama', model: 'deepseek-v4-flash:cloud' });
  drive(inst, lines);
  const [U] = results(lines).map(r => r.usage);
  assert.equal(turnEnds.length, 1);
  assert.deepEqual(turnEnds[0].cacheEstimate, { inputTokens: U.input_tokens, cacheReadTokens: 0 });
});

// (b) A backend that reports its cache read is never estimated.
test('a cache-reporting capture: no turn carries an estimate', async (t) => {
  const lines = await fixture('nonclaude-ollama-v41.stdout.jsonl');
  const { inst, turnEnds } = await makeInstance(t, { backend: 'ollama', model: 'deepseek-v4.1-flash:cloud' });
  drive(inst, lines);
  assert.equal(turnEnds.length, 3);
  for (const ev of turnEnds) assert.equal(ev.cacheEstimate, null);
});

// (c) The derived capture against its real twin.
test('the derived never-reports-cache capture, against the real twin', async (t) => {
  const derived = await fixture('nonclaude-ollama-v41.derived-nocache.stdout.jsonl');
  const real = await fixture('nonclaude-ollama-v41.stdout.jsonl');
  const { inst, turnEnds } = await makeInstance(t, { backend: 'ollama', model: 'deepseek-v4.1-flash:cloud' });
  drive(inst, derived);
  const reported = results(derived).map(r => r.usage);
  const truth = results(real).map(r => r.usage.cache_read_input_tokens);
  assert.equal(turnEnds.length, 3);
  const est = turnEnds.map(ev => ev.cacheEstimate);

  await t.test('every turn re-splits the reported input exactly', () => {
    est.forEach((e, i) => assert.equal(e.inputTokens + e.cacheReadTokens, reported[i].input_tokens, `turn ${i + 1}`));
  });
  await t.test('premise: the derived input is the real input + real cache read', () => {
    const realInput = results(real).map(r => r.usage.input_tokens);
    reported.forEach((u, i) => assert.equal(u.input_tokens, realInput[i] + truth[i], `turn ${i + 1}`));
  });
  // Measured on this capture: turn 1 is −100% (the session's first call has no
  // baseline, while the real backend served a cached system prompt), turn 2 is
  // +9.24% (its last call's real read fell to the system prompt — an eviction
  // the estimate cannot see), turn 3 is +0.14%.
  await t.test('turn 1: the session\'s first call has no baseline, so nothing is cached', () => {
    assert.equal(est[0].cacheReadTokens, 0);
    assert.ok(truth[0] > 0, 'premise: the real backend served a cached prefix');
  });
  await t.test('turn 2: a real eviction makes the estimate overstate the read', () => {
    assert.ok(est[1].cacheReadTokens > truth[1]);
  });
  await t.test('turn 3: every call served warm, and the estimate is within 2% of the real read', () => {
    const err = Math.abs(est[2].cacheReadTokens - truth[2]) / truth[2];
    assert.ok(err <= 0.02, `relative error ${(err * 100).toFixed(2)}%`);
  });
});

// (d) The identity backend is never estimated, whatever its calls report.
test('the derived capture on the claude backend carries no estimate', async (t) => {
  const lines = await fixture('nonclaude-ollama-v41.derived-nocache.stdout.jsonl');
  const { inst, turnEnds } = await makeInstance(t, { backend: 'claude', model: 'claude-opus-5-5' });
  drive(inst, lines);
  assert.equal(turnEnds.length, 3);
  for (const ev of turnEnds) assert.equal(ev.cacheEstimate, undefined);
});

// Turn 3 of the derived capture: every line after turn 2's result.
async function turnThree() {
  const lines = await fixture('nonclaude-ollama-v41.derived-nocache.stdout.jsonl');
  const resultIdx = lines.map((l, i) => (JSON.parse(l).type === 'result' ? i : -1)).filter(i => i >= 0);
  return { before: lines.slice(0, resultIdx[1] + 1), after: lines.slice(resultIdx[1] + 1) };
}

// (e) A resume seeds the baseline from the transcript's last assistant usage;
// a prune / model-switch relaunch (_skipUsageSeed) starts with none.
test('resume: the replayed transcript seeds the first live call\'s baseline', async (t) => {
  const { sessionFilePath, localPlace } = await import('../src/projects.ts');
  const SID = 'e2000000-0000-4000-8000-000000000002';
  const transcript = await fixture('nonclaude-ollama-v41.derived-nocache.transcript.jsonl');
  const lastUsage = transcript.map(l => JSON.parse(l)).filter(o => o.type === 'assistant').at(-1).message.usage;
  const { after } = await turnThree();

  async function resumed(skipSeed) {
    const root = await mkdtemp('cc-nonclaude-resume-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const place = localPlace(root);
    const file = sessionFilePath(place, SID);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, transcript.join('\n') + '\n');
    const { inst, turnEnds } = await makeInstance(t, { backend: 'ollama', model: 'deepseek-v4.1-flash:cloud', place });
    inst.backingSessionId = SID;
    inst._skipUsageSeed = skipSeed;
    await inst.loadHistory(SID);
    drive(inst, after);
    assert.equal(turnEnds.length, 1);
    return turnEnds[0].cacheEstimate;
  }
  const seeded = await resumed(false);
  const unseeded = await resumed(true);
  assert.equal(seeded.cacheReadTokens - unseeded.cacheReadTokens, promptTokenSum(lastUsage) + lastUsage.output_tokens,
    'the first live call counts the seeded prompt + output as cached');
  assert.equal(seeded.inputTokens + seeded.cacheReadTokens, unseeded.inputTokens + unseeded.cacheReadTokens);
});

// (f) A context reset mid-stream drops the baseline: turn 3's first call is
// uncached again.
test('a compaction or a /clear before a turn drops the baseline for its first call', async (t) => {
  const { before, after } = await turnThree();
  const uninterrupted = await (async () => {
    const { inst, turnEnds } = await makeInstance(t, { backend: 'ollama', model: 'deepseek-v4.1-flash:cloud' });
    drive(inst, [...before, ...after]);
    return turnEnds[2].cacheEstimate;
  })();
  const deltas = (ls) => ls.map(l => JSON.parse(l)).filter(o => o.type === 'stream_event' && o.event.type === 'message_delta').map(o => o.event.usage);
  const firstCall = deltas(after)[0];
  const prevCall = deltas(before).at(-1);
  const baseline = promptTokenSum(prevCall) + prevCall.output_tokens;
  const resets = [
    ['compaction', JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } })],
    ['/clear', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'e2000000-0000-4000-8000-0000000000ff', model: 'deepseek-v4.1-flash:cloud' })],
  ];
  for (const [name, line] of resets) {
    await t.test(name, async () => {
      const { inst, turnEnds } = await makeInstance(t, { backend: 'ollama', model: 'deepseek-v4.1-flash:cloud' });
      drive(inst, [...before, line, ...after]);
      const est = turnEnds[2].cacheEstimate;
      // Uninterrupted, the first call reads min(its prompt, the previous call's
      // prompt + output); after the reset it reads nothing.
      assert.equal(uninterrupted.cacheReadTokens - est.cacheReadTokens, Math.min(promptTokenSum(firstCall), baseline));
      assert.equal(est.inputTokens + est.cacheReadTokens, uninterrupted.inputTokens + uninterrupted.cacheReadTokens);
    });
  }
});

// A turn that died before its result (a respawn, resume, rewind or prune wipes
// the session mid-turn) contributes nothing to the next turn's estimate.
test('a turn abandoned before its result adds nothing to the next turn after a wipe', async (t) => {
  const { before, after } = await turnThree();
  const firstDelta = after.findIndex(l => { const o = JSON.parse(l); return o.type === 'stream_event' && o.event.type === 'message_delta'; });
  const abandoned = after.slice(0, firstDelta + 1);
  assert.ok(abandoned.every(l => JSON.parse(l).type !== 'result'), 'premise: the abandoned prefix reaches no result');
  const warn = t.mock.method(console, 'warn', () => {});
  async function run(lines) {
    const { inst, turnEnds } = await makeInstance(t, { backend: 'ollama', model: 'deepseek-v4.1-flash:cloud' });
    drive(inst, before);
    drive(inst, lines);
    inst._wipeForResume();
    drive(inst, after);
    return turnEnds.at(-1).cacheEstimate;
  }
  const control = await run([]);
  const withAbandoned = await run(abandoned);
  assert.ok(control !== null, 'premise: the resumed turn is estimated');
  assert.deepEqual(withAbandoned, control);
  assert.equal(warn.mock.callCount(), 0);
});

// A {backend, model} change re-learns whether calls report a cache read: a
// session that saw a reporting call estimates again once the new pair's calls
// come back keyless.
test('a backend/model change through _refreshModelCapabilities re-enables the estimate', async (t) => {
  const real = await fixture('nonclaude-ollama-v41.stdout.jsonl');
  const derived = await fixture('nonclaude-ollama-v41.derived-nocache.stdout.jsonl');
  const resultIdx = (ls) => ls.map((l, i) => (JSON.parse(l).type === 'result' ? i : -1)).filter(i => i >= 0);
  const turn1 = real.slice(0, resultIdx(real)[0] + 1);
  const turn2 = derived.slice(resultIdx(derived)[0] + 1, resultIdx(derived)[1] + 1);
  async function run(switchPair) {
    const { inst, turnEnds } = await makeInstance(t, { backend: 'ollama', model: 'deepseek-v4.1-flash:cloud' });
    drive(inst, turn1);
    if (switchPair) {
      inst.backend = 'my-proxy';
      inst._refreshModelCapabilities();
    }
    drive(inst, turn2);
    assert.equal(turnEnds.length, 2);
    return turnEnds[1].cacheEstimate;
  }
  assert.equal(await run(false), null, 'premise: without a change the reporting backend is never estimated');
  const est = await run(true);
  assert.ok(est !== null && est.cacheReadTokens > 0, `estimated after the change: ${JSON.stringify(est)}`);
});

// The openrouter capture: an all-zero message_start, a real delta that reports
// a cache read. Live, the ctx reading comes from the delta fallback and nothing
// is estimated.
test('openrouter live: the delta supplies the ctx reading and its reported cache read means no estimate', async (t) => {
  const lines = await fixture('nonclaude-openrouter.stdout.jsonl');
  const { inst, turnEnds } = await makeInstance(t, { backend: 'openrouter', model: 'meta/muse-spark-1.3-contributor' });
  drive(inst, lines);
  const deltas = lines.map(l => JSON.parse(l)).filter(o => o.type === 'stream_event' && o.event.type === 'message_delta');
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].cacheEstimate, null);
  assert.equal(turnEnds[0].contextTokens, promptTokenSum(deltas.at(-1).event.usage));
});

// (g) Card 2026-0196: a zero-start backend's persisted assistant lines carry the
// real per-call usage, so a resume seeds a real ctx reading.
test('openrouter replay: a resumed zero-start session seeds a real ctx reading', async (t) => {
  const { sessionFilePath, localPlace } = await import('../src/projects.ts');
  const SID = 'e2000000-0000-4000-8000-000000000003';
  const transcript = await fixture('nonclaude-openrouter.transcript.jsonl');
  const lastUsage = transcript.map(l => JSON.parse(l)).filter(o => o.type === 'assistant').at(-1).message.usage;
  const root = await mkdtemp('cc-nonclaude-replay-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const place = localPlace(root);
  const file = sessionFilePath(place, SID);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, transcript.join('\n') + '\n');
  const { inst } = await makeInstance(t, { backend: 'openrouter', model: 'meta/muse-spark-1.3-contributor', place });
  inst.backingSessionId = SID;
  await inst.loadHistory(SID);
  assert.ok(promptTokenSum(lastUsage) > 0, 'premise: the persisted line carries a real prompt');
  assert.equal(inst.summary().contextTokens, promptTokenSum(lastUsage));
});
