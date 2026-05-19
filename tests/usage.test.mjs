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
  t.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-opus-4-7[1m]' } });
  assert.equal(t.effectiveModel(), 'claude-opus-4-7[1m]');
});

test('UsageTracker: turn_end accumulates cum but does NOT touch lastUsage', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const t = new UsageTracker();
  t.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-opus-4-7[1m]' } });
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
  t.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-opus-4-7' } });
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
  t.apply({ kind: 'turn_end' /* no usage */ });
  assert.equal(t.currentContextSize(), null);
  assert.equal(t.cum.turns, 0);
});

test('contextWindowFor: known models and unknown fallback', async () => {
  const { contextWindowFor } = await import(USAGE_URL);
  assert.equal(contextWindowFor('claude-opus-4-7[1m]'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-4-7'), 200_000);
  assert.equal(contextWindowFor('claude-sonnet-4-6'), 200_000);
  assert.equal(contextWindowFor('claude-haiku-4-5'), 200_000);
  // Unknown model → default.
  assert.equal(contextWindowFor('some-future-model'), 200_000);
  // Empty/null → default.
  assert.equal(contextWindowFor(''), 200_000);
  assert.equal(contextWindowFor(null), 200_000);
  assert.equal(contextWindowFor(undefined), 200_000);
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
  tracker.apply({ kind: 'system', subtype: 'init', data: { model: 'claude-opus-4-7[1m]' } });
  const model = 'claude-opus-4-7[1m]'; // 1M context

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
