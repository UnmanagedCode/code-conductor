// The per-model "accepts mid-turn steering" capability flag: its resolver
// (resolveMidTurnSteering — precedence, exact-id matching, opt-out polarity), the
// rows that may declare it, and the REST round-trip that must carry it
// (addCustomModel rebuilds each row from scratch and getCustomModels re-projects
// only known keys, so an unwired field is silently dropped on the next read).

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { addCustomModel, getCustomModels, resolveMidTurnSteering } from '../src/appSettings.ts';
import { OLLAMA_CLOUD_MODELS } from '../src/ollamaCloudModels.ts';
import { CLAUDE_BACKEND_ID } from '../src/modelVersions.ts';
import { Instance } from '../src/instances.ts';

// A controlled model carrying the opt-out, registered into the isolated settings
// store by the tests below — deliberately NOT a curated preset, so a change to
// the curated model list cannot break them.
const FLAGGED_MODEL = 'cc-test-steer-optout:cloud';
async function addFlaggedRow() {
  await addCustomModel({
    label: 'Steer opt-out (test)', model: FLAGGED_MODEL, backend: 'ollama',
    contextWindow: 256_000, midTurnSteering: false,
  });
}

describe('resolveMidTurnSteering', () => {
  let ctx, baseUrl, home;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    const r = await freshProjectsRoot();
    home = r.home;
    ctx.projectsRoot = r.projectsRoot;
  });
  afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

  test('the identity backend is always steerable, whatever the model id says', async () => {
    await addFlaggedRow();
    assert.equal(resolveMidTurnSteering({ backend: CLAUDE_BACKEND_ID, model: 'claude-opus-5' }), true);
    // Even an id that a row declares false for: the backend short-circuits BEFORE
    // the row is consulted.
    assert.equal(resolveMidTurnSteering({ backend: CLAUDE_BACKEND_ID, model: FLAGGED_MODEL }), true);
  });

  test('a curated row resolves its own declared steering polarity with no custom row of its id', () => {
    // What this buys, and what it does NOT. It pins the ARM'S POLARITY: an
    // inverted arm would defer every steer on every curated session, and this
    // catches that. It cannot pin the arm's EXISTENCE — while no curated row
    // declares the opt-out, deleting the arm is indistinguishable from the `true`
    // fallback, and no assertion can tell those two apart. The opt-out half of the
    // arm is covered through custom rows by the loop below. This test is where the
    // rows are unshadowed; the loop registers one per row.
    //
    // The expectation is the row's OWN declared polarity, never a hardcoded `true`.
    // `midTurnSteering` is a documented per-row field, so a hardcoded expectation
    // would pin the CONFIGURATION — that no row opts out — instead of the resolver,
    // and a catalog edit that only added a flagged row would red it while reporting
    // backwards (the arm would have behaved correctly). Reading the row's own value
    // makes a re-listing and a re-flag both inert.
    for (const preset of OLLAMA_CLOUD_MODELS) {
      assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: preset.model }),
        preset.midTurnSteering !== false,
        `${preset.model}: a catalog row resolves its own declared steering polarity`);
    }
  });

  test('unknown / empty ids resolve to steerable — the pre-flag behaviour', () => {
    assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: 'never-heard-of-it:cloud' }), true);
    assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: '' }), true);
    assert.equal(resolveMidTurnSteering({}), true);
  });

  test('the match is EXACT: a stripped tag is a different model', async () => {
    await addFlaggedRow();
    assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: FLAGGED_MODEL }), false,
      'the declared id is the flagged registry key');
    assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: 'cc-test-steer-optout' }), true,
      'the tagless id is not the flagged registry key');
    assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: `${FLAGGED_MODEL} ` }), true);
  });

  test('a custom row opts a curated preset out, for every row', async () => {
    // The other direction — a custom row overriding a FLAGGED preset back to
    // steerable — is deliberately absent: no curated row declares the opt-out any
    // more, so that direction has no subject. The resolver's preset arm reads
    // `preset.midTurnSteering !== false`, which from the catalog is only ever
    // reachable as `true`.
    for (const preset of OLLAMA_CLOUD_MODELS) {
      await addCustomModel({
        label: 'Opt-out', model: preset.model, backend: 'ollama',
        contextWindow: 1000, midTurnSteering: false,
      });
      assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: preset.model }), false,
        `${preset.model}: the custom row's opt-out wins over the unflagged preset`);
    }
  });

  test('addCustomModel stores the flag; only an explicit false opts out', async () => {
    await addCustomModel({ label: 'A', model: 'a:cloud', backend: 'ollama', contextWindow: 1 });
    await addCustomModel({ label: 'B', model: 'b:cloud', backend: 'ollama', contextWindow: 1, midTurnSteering: false });
    // A junk value is not an opt-out — the flag is a declaration, not a guess.
    await addCustomModel({ label: 'C', model: 'c:cloud', backend: 'ollama', contextWindow: 1, midTurnSteering: 'no' });
    const by = Object.fromEntries(getCustomModels().map(m => [m.model, m.midTurnSteering]));
    assert.deepEqual(by, { 'a:cloud': true, 'b:cloud': false, 'c:cloud': true });
    assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: 'b:cloud' }), false);
  });

  // The gotcha this test exists for: addCustomModel rebuilds the persisted entry
  // field-by-field and getCustomModels re-projects only known keys, so a field
  // that is not wired through BOTH is dropped on the next read with no error.
  test('REST round-trip: midTurnSteering:false survives POST → GET → resolver', async () => {
    const post = await api(baseUrl, 'POST', '/api/settings/models/custom', {
      label: 'Flagged', model: 'flagged:cloud', backend: 'ollama', contextWindow: 256_000, midTurnSteering: false,
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.equal(post.body.added.midTurnSteering, false);

    const get = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(get.status, 200);
    const row = get.body.customModels.find(m => m.model === 'flagged:cloud');
    assert.equal(row.midTurnSteering, false, 'the flag survived the store round-trip');
    assert.equal(resolveMidTurnSteering({ backend: 'ollama', model: 'flagged:cloud' }), false);

    // Omitted on the wire ⇒ steerable, and still present as a boolean.
    const plain = await api(baseUrl, 'POST', '/api/settings/models/custom', {
      label: 'Plain', model: 'plain:cloud', backend: 'ollama', contextWindow: 256_000,
    });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.added.midTurnSteering, true);
  });
});

// ── X-T1 (PIN) ─────────────────────────────────────────────────────────────
// Instance.needsPostStopSteer is the ONE place the {status, flag} pair is tested —
// six injection sites read it instead of spelling it again — so its truth table is
// pinned here directly rather than inferred from six integration tests. Kills
// polarity inversion, a dropped status test and a dropped flag test in one place.
// It does NOT distinguish `!== true` from `=== false`: on a typed boolean those
// are equivalent, so no test can separate them.
describe('needsPostStopSteer', () => {
  // The lightest way to an Instance with no server (tests/mid-turn-annotation.mjs
  // idiom): the getter reads only `status` and `acceptsMidTurnSteering`.
  const inst = () => new Instance({
    id: 'nps-1', project: 'demo', cwd: '/tmp', mode: 'bypassPermissions',
    effort: 'high', thinking: 'adaptive', model: null,
  });

  test('true for exactly {status:turn} × {acceptsMidTurnSteering:false}', () => {
    for (const [status, accepts, want] of [
      ['turn', false, true],
      ['turn', true, false],
      ['idle', false, false],
      ['idle', true, false],
    ]) {
      const i = inst();
      i.status = status;
      i.acceptsMidTurnSteering = accepts;
      assert.equal(i.needsPostStopSteer, want,
        `status=${status} acceptsMidTurnSteering=${accepts}`);
    }
  });

  test('false for every non-turn status, even flagged', () => {
    // 'turn' is the ONLY status a message can be injected into.
    for (const status of ['spawning', 'idle', 'exited', 'crashed']) {
      const i = inst();
      i.status = status;
      i.acceptsMidTurnSteering = false;
      assert.equal(i.needsPostStopSteer, false, `status=${status}`);
    }
  });
});
