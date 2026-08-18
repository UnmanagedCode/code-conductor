// The client derives NO context capacity from the model it observed.
//
// usage.js's header records that the hardcoded family→window table was
// deleted: the server resolves capacity once from the concrete
// {backend, exact model} pair and ships it as `contextWindowTokens`. The
// client cannot redo that — `message_start` reports a bare model id with the
// `[1m]` build tag stripped, and a substitution backend's id is an opaque
// registry key — and the table that used to try defaulted anything it didn't
// recognise to 200k, a fabricated cap a real session was seen blowing past
// 256k input tokens without hitting.
//
// Why this file exists on top of tests/usage.test.mjs (which already asserts
// the denominator is server-supplied and that unknown capacity yields null):
// every one of those tests leaves `this.model === null`, because the tracker
// is only ever fed a `message_start` carrying no model. Reintroducing
//
//     const w = CONTEXT_WINDOWS[familyOf(this.model)];
//     if (w && !Number.isFinite(windowTokens)) return used / w;
//
// inside currentFillPct therefore survives that entire suite: familyOf(null)
// is null, the lookup is undefined, the branch never fires. This file sets
// the model — via BOTH write paths — before asserting, which kills it.
//
// The id list is driven off MODEL_FAMILIES, so a version added to the server
// catalog is covered here with no test edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL_FAMILIES } from '../src/modelVersions.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_URL = pathToFileURL(path.resolve(__dirname, '..', 'public', 'usage.js')).href;

// Every catalog id, plus the tagged launch form of any version that carries a
// launchTag (what the session actually launched with), plus two ids the
// catalog does not list: a substitution-backend-shaped id and a Claude id
// from a future release. A client-side table would have to guess at all four
// shapes.
const MODEL_IDS = [
  ...MODEL_FAMILIES.flatMap(f => f.versions.flatMap(v => (
    v.launchTag ? [v.id, v.id + v.launchTag] : [v.id]
  ))),
  'gpt-5.6-sol[1m]',
  'claude-future-9',
];

// The two paths that write `this.model` (usage.js apply()).
const SEED_VIA = {
  init: (t, id) => t.apply({ kind: 'system', subtype: 'init', data: { model: id } }),
  model_changed: (t, id) => t.apply({ kind: 'system', subtype: 'model_changed', data: { to: id } }),
};

// Every shape the server uses for "capacity unknown", plus the shapes a
// fabricated denominator would have to be guarded against.
const NO_CAPACITY = [undefined, null, 0, -1, NaN];

for (const [pathName, seed] of Object.entries(SEED_VIA)) {
  test(`UsageTracker: no capacity is derived from the model (seeded via ${pathName})`, async () => {
    const { UsageTracker } = await import(USAGE_URL);
    for (const id of MODEL_IDS) {
      const t = new UsageTracker();
      seed(t, id);
      t.apply({ kind: 'message_start', usage: { input_tokens: 500_000 } });

      // Non-vacuity guard: without this, a refactor that stopped recording the
      // model would leave every assertion below passing for the wrong reason.
      assert.equal(t.effectiveModel(), id, `tracker must have observed ${id}`);
      assert.equal(t.currentContextSize(), 500_000);

      for (const w of NO_CAPACITY) {
        assert.equal(t.currentFillPct(w), null,
          `${id}: windowTokens=${String(w)} must yield null, not a model-derived denominator`);
      }
    }
  });
}

test('UsageTracker: a server-supplied capacity is used verbatim whatever the model', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  for (const id of MODEL_IDS) {
    const t = new UsageTracker();
    SEED_VIA.init(t, id);
    t.apply({ kind: 'message_start', usage: { input_tokens: 500_000 } });
    // 500k against a 1M window is 50% for EVERY model id — the observed model
    // never scales the denominator.
    assert.equal(t.currentFillPct(1_000_000), 0.5, `${id}: 500k/1M`);
    assert.equal(t.currentFillPct(200_000), 2.5, `${id}: overflow is reported, not clamped`);
  }
});
