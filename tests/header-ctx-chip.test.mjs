// Tests for the ctx half of the combined chip AS RENDERED by the real
// renderCombinedChip in header.js — body text, tooltip and fill class.
//
// The bug these pin: the tooltip formatted BOTH ctxUsed and ctxWindow while
// guarding only `ctxUsed != null`, so the legitimate state "reading known,
// capacity unknown" (`inst.contextWindowTokens: null` — an out-of-catalog model,
// a deleted custom-model row, or the window before the first status re-emit on a
// spawn with no --model) threw `Cannot read properties of null (reading
// 'toLocaleString')` out of header.update() and aborted the whole header render.
//
// tests/usage.test.mjs already covers used-known/window-null — but against a
// hand-rolled copy of the ctx-half string, so it only ever exercised the body.
// These drive header.update() itself, which is the frame that crashed.
//
// Same happy-dom + installHeader() harness as tests/header-usage-popover.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const INDEX_HTML = path.resolve(__dirname, '..', 'public', 'index.html');

async function setup() {
  const html = await fs.readFile(INDEX_HTML, 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  window.document.documentElement.innerHTML = html;
  const document = window.document;

  const dom = {
    composerInput: document.getElementById('composer-input'),
    modeSelect: document.getElementById('mode-select'),
    killBtn: document.getElementById('kill-btn'),
    muteBtn: document.getElementById('mute-btn'),
    resumeBtn: document.getElementById('resume-btn'),
    instanceTitle: document.getElementById('instance-title'),
    turnIndicator: document.getElementById('turn-indicator'),
    tiLeft: document.getElementById('ti-left'),
    tiDot: document.getElementById('ti-dot'),
    tiLabel: document.getElementById('ti-label'),
    tiEllipsis: document.getElementById('ti-ellipsis'),
    tiInterruptNow: document.getElementById('ti-interrupt-now'),
    tiUsageSlot: document.getElementById('ti-usage-slot'),
    syncBtn: document.getElementById('sync-btn'),
    mergeBtn: document.getElementById('merge-btn'),
    debugBtn: document.getElementById('debug-btn'),
    renameSessionBtn: document.getElementById('rename-session-btn'),
    changeModelBtn: document.getElementById('change-model-btn'),
    sessionStatsBtn: document.getElementById('session-stats-btn'),
    pruneSessionBtn: document.getElementById('prune-session-btn'),
    autoApprovePlanBtn: document.getElementById('auto-approve-plan-btn'),
    overflowMenu: document.getElementById('overflow-menu'),
    overflowToggle: document.getElementById('overflow-toggle'),
  };
  for (const [k, v] of Object.entries(dom)) {
    assert.ok(v, `dom.${k} must resolve to a real element from index.html`);
  }

  const { installHeader } = await import(pathToFileURL(path.join(PUB, 'header.js')).href + `?t=${Math.random()}`);
  const { UsageTracker, RateLimitTracker } = await import(pathToFileURL(path.join(PUB, 'usage.js')).href);

  let instances = [];
  let activeId = null;
  const usageByInstance = new Map();
  const composer = { disable() { this.disabled = true; }, set(s) { this.disabled = false; Object.assign(this, s); } };
  const conversation = { setUserActionsEnabled() {} };

  const header = installHeader({
    dom,
    getActiveId: () => activeId,
    getInstances: () => instances,
    setActiveStatus: () => {},
    setActiveMode: () => {},
    getUsage: (id) => {
      if (!usageByInstance.has(id)) usageByInstance.set(id, new UsageTracker());
      return usageByInstance.get(id);
    },
    globalRLTracker: new RateLimitTracker(),
    getAccountUsage: () => null,
    getAccountUsageStale: () => false,
    composer,
    conversation,
    closeOverflow: () => {},
  });

  return {
    window, document, dom, header,
    setInstances: (v) => { instances = v; },
    setActiveId: (v) => { activeId = v; },
    getUsageTracker: (id) => {
      if (!usageByInstance.has(id)) usageByInstance.set(id, new UsageTracker());
      return usageByInstance.get(id);
    },
  };
}

const BASE_INSTANCE = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'plan',
  model: 'some-uncatalogued-model', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false, backend: 'claude',
};

// Renders one instance + usage state and hands back the live chip element.
// `contextWindowTokens` is spread in by the caller so a test can omit the key
// entirely (the `undefined` case) rather than only pass null.
async function renderChip({ instance, applyUsage }) {
  const h = await setup();
  h.setInstances([{ ...BASE_INSTANCE, ...instance }]);
  h.setActiveId('inst-1');
  if (applyUsage) h.getUsageTracker('inst-1').apply(applyUsage);
  h.header.update();
  const chip = h.dom.tiUsageSlot.querySelector('.ih-combined');
  assert.ok(chip, 'combined chip must be rendered into the usage slot');
  return chip;
}

// A live context reading of 250k tokens. message_start is the only writer of
// the tracker's lastUsage (see public/usage.js) — turn_end must never feed it.
const MSG_START_250K = {
  kind: 'message_start',
  usage: { input_tokens: 50_000, cache_read_input_tokens: 190_000, cache_creation_input_tokens: 10_000 },
};

// 1. The crash itself: a known reading against an unknown capacity must render.
test('ctx chip renders (does not throw) when the reading is known but capacity is null', async () => {
  let chip;
  await assert.doesNotReject(
    async () => { chip = await renderChip({ instance: { contextWindowTokens: null }, applyUsage: MSG_START_250K }); },
    'header.update() must not throw when contextWindowTokens is null',
  );
  assert.match(chip.textContent, /^ctx —/, 'body must read `ctx —` with no fabricated percentage');
  assert.match(chip.className, /\bih-usage-empty\b/, 'unknown capacity must not colour-grade the chip');
});

// 2. That tooltip states the real measured count and NO denominator.
test('unknown-capacity tooltip names the used tokens and fabricates no denominator', async () => {
  const chip = await renderChip({ instance: { contextWindowTokens: null }, applyUsage: MSG_START_250K });
  assert.match(chip.title, /Context: 250,000 tokens used \(capacity unknown\)/);
  assert.doesNotMatch(chip.title, /\d\s*\/\s*\d/, 'no used/capacity pair when capacity is unknown');
  assert.doesNotMatch(chip.title, /NaN|null|undefined|Infinity/, 'no leaked non-value in the tooltip');
  assert.doesNotMatch(chip.title, /\b0 tokens\b/, 'a `?? 0` fallback would read as a measured zero');
});

// 3. "Capacity unknown" and "no turn yet" must stay distinct states.
test('a fresh session with no reading gets the first-turn tooltip, not the unknown-capacity one', async () => {
  const chip = await renderChip({ instance: { contextWindowTokens: null } });
  assert.match(chip.textContent, /^ctx —/);
  assert.ok(
    chip.title.startsWith('Context usage appears after the first turn.'),
    `no-reading tooltip must be the first-turn message, got: ${chip.title}`,
  );
  assert.doesNotMatch(chip.title, /capacity unknown/, 'the two null states must not collapse into one');
});

// 4. The both-known happy path is unchanged.
test('a known reading against a known capacity renders the percentage and both figures', async () => {
  const chip = await renderChip({
    instance: { contextWindowTokens: 1_000_000 },
    applyUsage: MSG_START_250K,
  });
  assert.match(chip.textContent, /^ctx 25% · 250k\/1\.0M/);
  assert.ok(
    chip.title.startsWith('Context: 250,000/1,000,000 tokens'),
    `both-known tooltip must carry both figures, got: ${chip.title}`,
  );
  assert.match(chip.className, /\bih-usage-low\b/);
});

// 5. A partial usage payload (only one of the three token fields) still renders.
test('a partial message_start.usage with an unknown capacity still renders its real count', async () => {
  const chip = await renderChip({
    instance: { contextWindowTokens: null },
    applyUsage: { kind: 'message_start', usage: { input_tokens: 5 } },
  });
  assert.match(chip.textContent, /^ctx —/);
  assert.match(chip.title, /Context: 5 tokens used \(capacity unknown\)/,
    'a small/partial reading is still a real reading, not a missing one');
});

// 6a/6b. The `<= 0` boundary. The body's denominator is gated on ctxFrac, and
// currentFillPct rejects `windowTokens <= 0` as well as non-finite (usage.js:122),
// so the tooltip must key on that same predicate. A tooltip guarded by a second
// `Number.isFinite(ctxWindow)` test agrees everywhere EXCEPT here, where it would
// print `Context: 250,000/0 tokens` against a body reading `ctx —`.
test('a context window of 0 takes the unknown-capacity branch, in lockstep with the body', async () => {
  const chip = await renderChip({ instance: { contextWindowTokens: 0 }, applyUsage: MSG_START_250K });
  assert.match(chip.textContent, /^ctx —/, 'body must not render a percentage against a zero window');
  assert.match(chip.title, /Context: 250,000 tokens used \(capacity unknown\)/,
    'tooltip must agree with the body — a `Number.isFinite` guard would emit `250,000/0` here');
  assert.doesNotMatch(chip.title, /\d\s*\/\s*\d/, 'no fabricated zero denominator');
});

test('the smallest positive window is still a known capacity (the boundary is not off by one)', async () => {
  const chip = await renderChip({ instance: { contextWindowTokens: 1 }, applyUsage: MSG_START_250K });
  assert.ok(
    chip.title.startsWith('Context: 250,000/1 tokens'),
    `a window of 1 is a real capacity, got: ${chip.title}`,
  );
  assert.doesNotMatch(chip.title, /capacity unknown/, 'a `>= 0` or `> 1` guard would wrongly land here');
});

// 6. An absent key behaves the same as an explicit null.
test('an instance summary with no contextWindowTokens key is treated as unknown capacity', async () => {
  const chip = await renderChip({ instance: {}, applyUsage: MSG_START_250K });
  assert.match(chip.textContent, /^ctx —/);
  assert.match(chip.title, /Context: 250,000 tokens used \(capacity unknown\)/,
    'undefined capacity must take the same branch as null');
});
