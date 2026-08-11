// The enforcement level's allow-list and the normalization that absorbs the
// retired `off`.
//
// `off` was the rollout gate: fully inert, and the default. It is gone — there
// are two levels now, and the only place a stale `off` can still arrive from is a
// pending-resume.json written by the previous build. These are pure-function
// tests; the end-to-end behaviour of each level lives in
// tests/playbook-enforce.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBOOK_ENFORCEMENT_MODES, DEFAULT_PLAYBOOK_ENFORCEMENT,
  isPlaybookEnforcement, normalizePlaybookEnforcement,
} from '../src/playbooks.ts';

test('the allow-list is exactly the two surviving levels, defaulting to enforce', () => {
  // Every ingress validator (the spawn route, the WS toggle) derives its accepted
  // set from this constant, so widening it here silently widens both.
  assert.deepEqual([...PLAYBOOK_ENFORCEMENT_MODES], ['warn', 'enforce']);
  // The shipped default: a fresh install with nothing persisted starts
  // ENFORCED. This is the fallback behind getDefaultPlaybookEnforcement, not a
  // second source — see tests/playbook-enforcement-default.test.mjs.
  assert.equal(DEFAULT_PLAYBOOK_ENFORCEMENT, 'enforce');
  assert.equal(isPlaybookEnforcement('off'), false,
    'the retired level must not validate, or the ingress boundaries would still accept it');
  assert.equal(isPlaybookEnforcement('warn'), true);
  assert.equal(isPlaybookEnforcement('enforce'), true);
});

// This pins the branch AND the contract: 'off' must resolve to 'warn'
// specifically, not merely "whatever the default currently is" — a session
// recorded as unenforced must never come back enforced. Written literally
// (not derived from DEFAULT_PLAYBOOK_ENFORCEMENT) so a future flip of the
// shipped default back to 'warn' cannot make this assertion vacuously true
// again; it stays a real branch check either way.
test('a persisted `off` normalizes to warn — an unenforced session never resurrects enforced', () => {
  assert.equal(normalizePlaybookEnforcement('off'), 'warn');
});

test('normalization passes the live levels through untouched', () => {
  assert.equal(normalizePlaybookEnforcement('warn'), 'warn');
  assert.equal(normalizePlaybookEnforcement('enforce'), 'enforce');
});

test('an absent or unrecognised level falls back to the shipped default', () => {
  // Read off the constant, not written literally: this pins "falls back to THE
  // default" rather than a level that happens to be it today.
  for (const v of [undefined, null, '', 'always', 'sometimes', 7, {}, []]) {
    assert.equal(normalizePlaybookEnforcement(v), DEFAULT_PLAYBOOK_ENFORCEMENT,
      `${JSON.stringify(v) ?? String(v)} must fall back to the default`);
  }
});
