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

test('the allow-list is exactly the two surviving levels, defaulting to warn', () => {
  // Every ingress validator (the spawn route, the WS toggle) derives its accepted
  // set from this constant, so widening it here silently widens both.
  assert.deepEqual([...PLAYBOOK_ENFORCEMENT_MODES], ['warn', 'enforce']);
  // The shipped default: a fresh install with nothing persisted starts
  // UNENFORCED. This is the fallback behind getDefaultPlaybookEnforcement, not a
  // second source — see tests/playbook-enforcement-default.test.mjs.
  assert.equal(DEFAULT_PLAYBOOK_ENFORCEMENT, 'warn');
  assert.equal(isPlaybookEnforcement('off'), false,
    'the retired level must not validate, or the ingress boundaries would still accept it');
  assert.equal(isPlaybookEnforcement('warn'), true);
  assert.equal(isPlaybookEnforcement('enforce'), true);
});

// HONEST LABEL: this assertion pins a VALUE CONTRACT, not a branch.
//
// It was written when DEFAULT_PLAYBOOK_ENFORCEMENT was 'enforce', where it also
// distinguished the `if (v === 'off') return 'warn'` branch from the fallback.
// The shipped default is now 'warn', so the two coincide and deleting that branch
// changes nothing observable — no test here or anywhere else can kill that
// mutant, and none pretends to. What survives is the contract that matters in
// production: a session recorded as unenforced must never come back enforced.
// Should the shipped default ever return to 'enforce', this regains its power
// with no edit.
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
