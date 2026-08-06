// The enforcement level's allow-list and the normalization that absorbs the
// retired `off`.
//
// `off` was the rollout gate: fully inert, and the default. Both are gone — there
// are two levels now, enforcement is on by default, and the only place a stale
// `off` can still arrive from is a pending-resume.json written by the previous
// build. These are pure-function tests; the end-to-end behaviour of each level
// lives in tests/playbook-enforce.test.mjs.

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
  assert.equal(DEFAULT_PLAYBOOK_ENFORCEMENT, 'enforce');
  assert.equal(isPlaybookEnforcement('off'), false,
    'the retired level must not validate, or the ingress boundaries would still accept it');
  assert.equal(isPlaybookEnforcement('warn'), true);
  assert.equal(isPlaybookEnforcement('enforce'), true);
});

test('a persisted `off` normalizes to warn, NOT to the enforcing default', () => {
  // The direction matters more than the mapping: bringing a session that was
  // running unenforced back as enforced is a silent UPGRADE, which would start
  // refusing calls that used to be allowed with nothing announcing the change.
  assert.equal(normalizePlaybookEnforcement('off'), 'warn');
});

test('normalization passes the live levels through untouched', () => {
  assert.equal(normalizePlaybookEnforcement('warn'), 'warn');
  assert.equal(normalizePlaybookEnforcement('enforce'), 'enforce');
});

test('an absent or unrecognised level falls back to the enforcing default', () => {
  // Distinct from the 'off' case: there is no evidence such a session was ever
  // deliberately unenforced, so it gets the default every new conductor gets.
  for (const v of [undefined, null, '', 'always', 'sometimes', 7, {}, []]) {
    assert.equal(normalizePlaybookEnforcement(v), 'enforce',
      `${JSON.stringify(v) ?? String(v)} must fall back to the default`);
  }
});
