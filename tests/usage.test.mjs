// Tests for the per-instance context-usage tracker that drives the
// `ctx N%` header chip + session-totals popover.
//
// Two layers:
//   1. Pure unit tests over UsageTracker + the format helpers (no DOM).
//   2. happy-dom assertions that the chip lands in the rendered header
//      with the right class transition across the 50% / 80% thresholds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const USAGE_URL = pathToFileURL(path.join(PUB, 'usage.js')).href;

test('UsageTracker: initial state has no current size or totals', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  assert.equal(t.currentContextSize(), null);
  assert.equal(t.currentFillPct(), null);
  assert.deepEqual(t.cum, {
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0,
    cost: 0, turns: 0, durationMs: 0,
  });
});

test('UsageTracker: system/init captures model authoritatively', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-opus-4-8[1m]' } });
  assert.equal(t.effectiveModel(), 'claude-opus-4-8[1m]');
});

test('UsageTracker: live-tracked model wins over a stale spawn-time modelOverride', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  const spawnOverride = 'claude-sonnet-4-6[1m]';
  // Before any stream event, the spawn-time override is the only info we have.
  assert.equal(t.effectiveModel(spawnOverride), spawnOverride);

  t.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-sonnet-4-6[1m]' } });
  assert.equal(t.effectiveModel(spawnOverride), 'claude-sonnet-4-6[1m]');

  // Mid-session switch via model_changed — the live tracker must now win
  // over the stale spawn-time override, including for the context window.
  t.apply({ kind: 'system', subtype: 'model_changed', data: { from: 'claude-sonnet-4-6[1m]', to: 'claude-opus-4-8' } });
  assert.equal(t.effectiveModel(spawnOverride), 'claude-opus-4-8',
    'live tracker beats the stale spawn override once populated');
  // The matching capacity update is now the SERVER's job: _trackModel recomputes
  // contextWindowTokens and re-emits the summary on a real switch. This tracker
  // only owns the model label. (Pinned server-side in tests/context-window.test.mjs.)
});

test('UsageTracker: message_start also updates the live model (flips at the true turn boundary)', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-sonnet-4-6[1m]' } });
  t.apply({ kind: 'message_start', usage: { input_tokens: 10 }, model: 'claude-opus-4-8' });
  assert.equal(t.effectiveModel(), 'claude-opus-4-8');
  assert.equal(t.currentContextSize(), 10, 'message_start usage tracking is unaffected by the model field');
});

test('UsageTracker: turn_end accumulates cum but does NOT touch lastUsage', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-opus-4-8[1m]' } });
  // turn_end.usage is the per-turn SUM across every agent-loop LLM
  // call (e.g. 100 tool calls each reading 74k cached → 7.4M). Feeding
  // it as "current context size" inflates the chip wildly. Verify the
  // tracker now treats it as cum-only.
  t.apply({
    kind: 'turn_end',
    durationMs: 1200,
    cost: 0.01,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 7_400_000,
      cache_creation_input_tokens: 73_000,
    },
  });
  assert.equal(t.currentContextSize(), null,
    'no message_start has fired yet → current size is unknown, not the inflated sum');
  assert.deepEqual(t.cum, {
    inputTokens: 100, outputTokens: 50,
    cacheRead: 7_400_000, cacheCreation: 73_000,
    cost: 0.01, turns: 1, durationMs: 1200,
  });

  // A second turn keeps summing into cum, still no effect on lastUsage.
  t.apply({
    kind: 'turn_end',
    durationMs: 800,
    cost: 0.02,
    usage: {
      input_tokens: 200,
      output_tokens: 70,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 100,
    },
  });
  assert.equal(t.currentContextSize(), null);
  assert.deepEqual(t.cum, {
    inputTokens: 300, outputTokens: 120,
    cacheRead: 7_402_000, cacheCreation: 73_100,
    cost: 0.03, turns: 2, durationMs: 2000,
  });
});

test('UsageTracker: turn_end WITHOUT usage still counts a turn (Ollama shape)', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'system', subtype: 'init', data: { model: 'qwen2.5-coder' } });
  // The Ollama backend (`ollama launch claude`) emits `result` lines with no
  // `usage` block (see tests/fixtures/scenario-ollama-bare-model.json). The chip
  // must still advance turns + duration + cost — gating on usage undercounted
  // multi-turn sessions down to whatever few turns happened to carry usage.
  for (let i = 0; i < 3; i++) {
    t.apply({ kind: 'turn_end', durationMs: 10, costDelta: 0.0001 });
  }
  const { cost, ...rest } = t.cum;
  assert.deepEqual(rest, {
    inputTokens: 0, outputTokens: 0,   // no fabrication — no usage was present
    cacheRead: 0, cacheCreation: 0,
    turns: 3, durationMs: 30,
  });
  assert.ok(Math.abs(cost - 0.0003) < 1e-9, `expected cost ~0.0003, got ${cost}`);
});

test('UsageTracker: turn_end WITH usage still accumulates tokens (Anthropic — no regression)', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({
    kind: 'turn_end', durationMs: 500, costDelta: 0.01,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 },
  });
  t.apply({
    kind: 'turn_end', durationMs: 700, costDelta: 0.02,
    usage: { input_tokens: 200, output_tokens: 70, cache_read_input_tokens: 3000, cache_creation_input_tokens: 200 },
  });
  const { cost, ...rest } = t.cum;
  assert.deepEqual(rest, {
    inputTokens: 300, outputTokens: 120,
    cacheRead: 5000, cacheCreation: 300,
    turns: 2, durationMs: 1200,
  });
  assert.ok(Math.abs(cost - 0.03) < 1e-9, `expected cost ~0.03, got ${cost}`);
});

test('UsageTracker: mixed usage/no-usage turns — turns count all, tokens only the usage-bearing ones', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'turn_end', durationMs: 10, costDelta: 0.0001 });                              // no usage
  t.apply({ kind: 'turn_end', durationMs: 20, costDelta: 0.01, usage: { input_tokens: 100, output_tokens: 40 } });
  t.apply({ kind: 'turn_end', durationMs: 30, costDelta: 0.0001 });                              // no usage
  const { cost, ...rest } = t.cum;
  assert.deepEqual(rest, {
    inputTokens: 100, outputTokens: 40,   // only the middle turn carried usage
    cacheRead: 0, cacheCreation: 0,
    turns: 3, durationMs: 60,
  });
  assert.ok(Math.abs(cost - 0.0102) < 1e-9, `expected cost ~0.0102, got ${cost}`);
});

test('UsageTracker: message_start is the only source of currentContextSize', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'message_start', usage: {
    input_tokens: 100, output_tokens: 0,
    cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0,
  }});
  assert.equal(t.currentContextSize(), 50_100);
  // turn_end with WILDLY larger summed values must NOT clobber the chip.
  t.apply({ kind: 'turn_end', cost: 0.5, durationMs: 60_000, usage: {
    input_tokens: 500, output_tokens: 10_000,
    cache_read_input_tokens: 5_000_000, cache_creation_input_tokens: 200_000,
  }});
  assert.equal(t.currentContextSize(), 50_100,
    'currentContextSize stays anchored to last message_start, ignoring summed turn_end');
});

test('UsageTracker: message_start updates current size mid-turn without inflating cum', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  // Long-running turn: three agent-loop steps within one turn, each
  // fires its own message_start with growing input-side counts as tool
  // results stack up in context.
  t.apply({
    kind: 'message_start',
    usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  });
  assert.equal(t.currentContextSize(), 1100);
  assert.equal(t.cum.turns, 0, 'message_start must not bump turns');
  assert.equal(t.cum.inputTokens, 0, 'message_start must not bump cum.inputTokens');

  t.apply({
    kind: 'message_start',
    usage: { input_tokens: 200, output_tokens: 0, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
  });
  assert.equal(t.currentContextSize(), 5200);
  assert.equal(t.cum.turns, 0);

  // Final result lands — cum gets the authoritative per-turn aggregate.
  t.apply({
    kind: 'turn_end',
    durationMs: 4000,
    cost: 0.05,
    usage: { input_tokens: 300, output_tokens: 800, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 200 },
  });
  assert.equal(t.cum.turns, 1);
  assert.equal(t.cum.inputTokens, 300, 'cum reflects turn_end only, not the prior message_starts');
  assert.equal(t.cum.cacheRead, 10_000, 'cum sums the turn_end value (which is itself a per-turn aggregate)');
  // currentContextSize must NOT jump to turn_end's summed cache_read.
  // It stays anchored to the last message_start (5000 + 200).
  assert.equal(t.currentContextSize(), 5200);
});

test('UsageTracker: missing usage fields default to 0', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  // Use message_start since that's the source of currentContextSize now.
  t.apply({ kind: 'message_start', usage: { input_tokens: 100 } });
  assert.equal(t.currentContextSize(), 100);
  // turn_end with partial usage still accumulates correctly.
  t.apply({ kind: 'turn_end', usage: { input_tokens: 50 } });
  assert.equal(t.cum.cacheRead, 0);
  assert.equal(t.cum.cacheCreation, 0);
  assert.equal(t.cum.outputTokens, 0);
  assert.equal(t.cum.inputTokens, 50);
});

test('UsageTracker: reset clears everything', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-opus-4-8' } });
  t.apply({ kind: 'turn_end', cost: 1, usage: { input_tokens: 42 } });
  t.reset();
  assert.equal(t.currentContextSize(), null);
  assert.equal(t.cum.turns, 0);
  assert.equal(t.cum.cost, 0);
  // Note: model is *also* cleared, since a snapshot replay re-feeds
  // the init event before any turn_end.
  assert.equal(t.effectiveModel(), null);
});

test('UsageTracker: ignores unrelated event kinds', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'text_delta', text: 'hello' });
  t.apply({ kind: 'tool_use', name: 'Bash', input: {} });
  assert.equal(t.currentContextSize(), null);
  assert.equal(t.cum.turns, 0);
});

test('currentFillPct: the denominator is the server-supplied number, with no client-side table', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'message_start', usage: { input_tokens: 500_000 } });
  assert.equal(t.currentContextSize(), 500_000);

  // The client no longer knows or guesses any model's capacity: whatever the
  // server resolved is the denominator, verbatim.
  assert.equal(t.currentFillPct(1_000_000), 0.5);
  assert.equal(t.currentFillPct(200_000), 2.5);
  assert.equal(t.currentFillPct(256_000), 500_000 / 256_000);
});

test('currentFillPct: unknown capacity yields null, never a fabricated 200k default', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'message_start', usage: { input_tokens: 500_000 } });

  // THE regression: the old resolver defaulted any unrecognised model to 200k,
  // so a 1M session read "ctx 250%" and a session with genuinely unknown
  // capacity read as if it were measured. Unknown must stay unknown.
  for (const unknown of [null, undefined, 0, -1, NaN, 'lots']) {
    assert.equal(t.currentFillPct(unknown), null, `expected null for ${String(unknown)}`);
  }

  // Null also survives the no-usage case (both reasons collapse to `ctx —`).
  const fresh = new UsageTracker();
  assert.equal(fresh.currentFillPct(1_000_000), null);
});

test('usage.js exports no context-window table or resolver', async () => {
  const mod = await import(USAGE_URL);
  // Capacity has exactly one home (the server). A client-side resolver
  // reappearing here is a second source of truth that will drift.
  assert.equal(mod.contextWindowFor, undefined);
  assert.equal(mod.CONTEXT_WINDOWS, undefined);
  assert.equal(mod.DEFAULT_CONTEXT_WINDOW, undefined);
});

test('UsageTracker: seedContext supplies the current size when the tail has no message_start', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();

  // Nothing to seed with is a no-op, not a crash (field absent on older frames
  // and on every reset_snapshot).
  t.seedContext(null);
  t.seedContext(undefined);
  assert.equal(t.currentContextSize(), null);

  t.seedContext({ input_tokens: 79167, output_tokens: 0 });
  assert.equal(t.currentContextSize(), 79167);

  // Cache fields are summed the same way as a live message_start.
  t.reset();
  t.seedContext({ input_tokens: 2, cache_read_input_tokens: 105_488, cache_creation_input_tokens: 496 });
  assert.equal(t.currentContextSize(), 105_986);

  // A message_start replayed from the tail still wins (the seed runs first).
  t.apply({ kind: 'message_start', usage: { input_tokens: 500 } });
  assert.equal(t.currentContextSize(), 500);
});

test('UsageTracker: seeded snapshot replay renders the chip against the model window, not `ctx —`', async () => {
  const { UsageTracker, formatPct, formatTokens, fillClass } = await import(USAGE_URL);
  try {
    // Replay a snapshot in the exact order wsRouter uses: reset → seed → tail.
    // The tail is the production no-message_start shape: the trailing slice of a
    // long text block plus the turn footer. The denominator comes from the
    // instance summary's `contextWindowTokens`, mirroring renderCombinedChip.
    const chip = (tracker, windowTokens) => {
      const used = tracker.currentContextSize();
      const frac = tracker.currentFillPct(windowTokens);
      if (used == null || frac == null) return 'ctx —';
      return `ctx ${formatPct(frac)} · ${formatTokens(used)}/${formatTokens(windowTokens)}`;
    };

    const t = new UsageTracker();
    t.reset();
    t.seedContext({ input_tokens: 79167, output_tokens: 0 });
    for (const ev of [
      { kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'tail ' },
      { kind: 'text_end', msgId: 'm1', blockIdx: 0 },
      { kind: 'turn_end', subtype: 'success', durationMs: 10 },
    ]) t.apply(ev);

    // A 1M substitution model — the case the old client table got wrong by
    // defaulting anything it didn't recognise to 200k (which would read 40%).
    assert.equal(chip(t, 1_000_000), 'ctx 8% · 79k/1.0M');
    assert.equal(fillClass(t.currentFillPct(1_000_000)), 'ih-usage-low');
    // A custom model on a user-defined substitution backend uses its declared window.
    const t2 = new UsageTracker();
    t2.seedContext({ input_tokens: 256_000 });
    assert.equal(chip(t2, 512_000), 'ctx 50% · 256k/512k');

    // Without the seed the same tail yields the reported symptom.
    const bare = new UsageTracker();
    for (const ev of [{ kind: 'text_end', msgId: 'm1', blockIdx: 0 }, { kind: 'turn_end', subtype: 'success' }]) bare.apply(ev);
    assert.equal(chip(bare, 1_000_000), 'ctx —');
    // …as does a seeded tracker whose capacity the server could not resolve.
    assert.equal(chip(t, null), 'ctx —');
  } finally { /* no client catalog to reset — capacity is server-side now */ }
});

test('fillClass: thresholds at 50% and 80%', async () => {
  const { fillClass } = await import(USAGE_URL);
  assert.equal(fillClass(null), 'ih-usage-empty');
  assert.equal(fillClass(0), 'ih-usage-low');
  assert.equal(fillClass(0.49), 'ih-usage-low');
  assert.equal(fillClass(0.5), 'ih-usage-mid');
  assert.equal(fillClass(0.79), 'ih-usage-mid');
  assert.equal(fillClass(0.8), 'ih-usage-high');
  assert.equal(fillClass(1.5), 'ih-usage-high');
});

test('formatTokens: scales to k / M with sensible precision', async () => {
  const { formatTokens } = await import(USAGE_URL);
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(42), '42');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1_000), '1.0k');
  assert.equal(formatTokens(9_900), '9.9k');
  assert.equal(formatTokens(12_345), '12k');
  assert.equal(formatTokens(200_000), '200k');
  assert.equal(formatTokens(1_000_000), '1.0M');
  assert.equal(formatTokens(10_000_000), '10M');
});

test('formatPct: rounds + handles tiny non-zero', async () => {
  const { formatPct } = await import(USAGE_URL);
  assert.equal(formatPct(null), '—');
  assert.equal(formatPct(0), '0%');
  assert.equal(formatPct(0.001), '<1%');
  assert.equal(formatPct(0.5), '50%');
  assert.equal(formatPct(0.797), '80%');
  assert.equal(formatPct(1), '100%');
});

test('formatDuration: seconds / minutes / hours', async () => {
  const { formatDuration } = await import(USAGE_URL);
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatDuration(500), '1s');
  assert.equal(formatDuration(30_000), '30s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_660_000), '1h 1m');
});

test('formatResetWhen: near reset matches formatResetTime; far reset (>24h) adds weekday', async () => {
  const { formatResetWhen, formatResetTime } = await import(USAGE_URL);
  assert.equal(formatResetWhen(null), null);
  assert.equal(formatResetWhen(NaN), null);

  const nearSecs = Math.floor(Date.now() / 1000) + 3600; // 1h out
  assert.equal(formatResetWhen(nearSecs), formatResetTime(nearSecs));

  const farSecs = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60; // 3 days out
  const far = formatResetWhen(farSecs);
  const d = new Date(farSecs * 1000);
  const weekday = d.toLocaleDateString([], { weekday: 'short' });
  assert.ok(far.startsWith(`resets ${weekday} `), `expected weekday prefix, got "${far}"`);
});

// --- DOM-level test: chip threshold transitions ---

async function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  // Fresh module cache by appending a cache-buster to the URL is
  // overkill — happy-dom + dynamic imports give us idempotent loads.
  const mod = await import(USAGE_URL);
  document.body.innerHTML = '';
  return { document, ...mod };
}

test('DOM: tracker drives chip-class transitions across thresholds', async () => {
  const { document, UsageTracker, fillClass, formatPct } = await setupDOM();
  const tracker = new UsageTracker();
  tracker.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-opus-4-8[1m]' } });
  const model = 1_000_000; // server-resolved capacity for Opus 4.8

  function chipClassNow() {
    return fillClass(tracker.currentFillPct(model));
  }
  function chipPctNow() {
    return formatPct(tracker.currentFillPct(model));
  }

  // No message_start yet → empty class.
  assert.equal(chipClassNow(), 'ih-usage-empty');

  // 30% of 1M = 300k → low. Driven by message_start (per-call prompt
  // size), which is what actually drives the chip live mid-turn.
  tracker.apply({ kind: 'message_start', usage: { input_tokens: 300_000 } });
  assert.equal(chipClassNow(), 'ih-usage-low');
  assert.equal(chipPctNow(), '30%');

  // 60% → mid.
  tracker.apply({ kind: 'message_start', usage: { input_tokens: 600_000 } });
  assert.equal(chipClassNow(), 'ih-usage-mid');
  assert.equal(chipPctNow(), '60%');

  // 85% → high.
  tracker.apply({ kind: 'message_start', usage: { input_tokens: 850_000 } });
  assert.equal(chipClassNow(), 'ih-usage-high');
  assert.equal(chipPctNow(), '85%');
});

test('DOM: a seeded tracker renders a graded chip, not the empty state', async () => {
  // The re-subscribe path for a tail with no message_start: the seed alone has to
  // carry the chip out of `ih-usage-empty`/`ctx —` into a real reading.
  const { UsageTracker, fillClass, formatPct } = await setupDOM();
  const model = 1_000_000; // server-resolved capacity for Opus 4.8
  const tracker = new UsageTracker();
  tracker.reset();
  assert.equal(fillClass(tracker.currentFillPct(model)), 'ih-usage-empty');
  assert.equal(formatPct(tracker.currentFillPct(model)), '—');

  tracker.seedContext({ input_tokens: 2, cache_read_input_tokens: 600_000 });
  tracker.apply({ kind: 'turn_end', subtype: 'success' }); // the only in-tail event
  assert.equal(fillClass(tracker.currentFillPct(model)), 'ih-usage-mid');
  assert.equal(formatPct(tracker.currentFillPct(model)), '60%');
});
