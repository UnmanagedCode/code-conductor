// Direct unit pins on the model/tier/role/backend catalog (src/modelVersions.ts,
// converted to type-safe TS in round 1). The integration suite exercises the
// catalog through /api/settings/models and the spawn surfaces; this file pins
// the catalog's internal invariants and the launch-tag/context-window policy
// that mutation of the catalog would otherwise break silently.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_FAMILIES, DEFAULT_VERSIONS, MANAGED_BACKENDS, MANAGED_BACKEND_IDS, CLAUDE_BACKEND_ID,
  CAPABILITY_TIERS, DEFAULT_TIER_BACKEND, ROLES, DEFAULT_ROLE_BINDING,
  isKnownFamily, isKnownTier, isKnownRole, isKnownVersion, isKnownClaudeModel,
  defaultVersion, familyOf, claudeContextWindowTokens, canonicalizeModel,
} from '../src/modelVersions.ts';

describe('catalog well-formedness', () => {
  test('every family default is one of its own versions', () => {
    for (const f of MODEL_FAMILIES) {
      const ids = f.versions.map(v => v.id);
      assert.ok(ids.includes(f.default), `${f.family} default '${f.default}' not listed in its versions`);
      assert.ok(f.label, `${f.family} label present`);
    }
  });

  test('every version id is unique across all families', () => {
    const all = MODEL_FAMILIES.flatMap(f => f.versions.map(v => v.id));
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    assert.equal(dupes.length, 0, `duplicate version ids: ${dupes.join(', ')}`);
  });

  test('every version declares a positive finite contextWindow', () => {
    for (const f of MODEL_FAMILIES) {
      for (const v of f.versions) {
        assert.ok(Number.isFinite(v.contextWindow) && v.contextWindow > 0,
          `${v.id} must carry a positive finite native contextWindow`);
      }
    }
  });

  test('DEFAULT_VERSIONS maps each family to exactly its default version id', () => {
    // A mutated default (or a re-derived map) fails here, not just the
    // well-formedness check above.
    assert.deepEqual(DEFAULT_VERSIONS, {
      fable: 'claude-fable-5',
      opus: 'claude-opus-4-8',
      sonnet: 'claude-sonnet-5',
      haiku: 'claude-haiku-4-5',
    });
  });
});

describe('canonicalizeModel — launch-tag policy', () => {
  test('applies the launch tag for a tagged claude model', () => {
    assert.equal(canonicalizeModel('claude-sonnet-4-6', CLAUDE_BACKEND_ID), 'claude-sonnet-4-6[1m]');
  });

  test('leaves an already-tagged id and an untagged id unchanged', () => {
    assert.equal(canonicalizeModel('claude-sonnet-4-6[1m]', CLAUDE_BACKEND_ID), 'claude-sonnet-4-6[1m]');
    assert.equal(canonicalizeModel('claude-opus-4-8', CLAUDE_BACKEND_ID), 'claude-opus-4-8');
    assert.equal(canonicalizeModel('claude-sonnet-5', CLAUDE_BACKEND_ID), 'claude-sonnet-5');
  });

  test('returns a substitution-backend id BYTE-EXACT, even when [1m]-suffixed', () => {
    // The load-bearing invariant: a non-claude model id is an opaque registry
    // key — stripping the tag would desynchronise this.model from the key the
    // session sidecar is stored under.
    assert.equal(canonicalizeModel('deepseek-v4-flash:cloud[1m]', 'ollama'), 'deepseek-v4-flash:cloud[1m]');
    assert.equal(canonicalizeModel('gpt-5.6-sol[1m]', 'my-proxy'), 'gpt-5.6-sol[1m]');
    assert.equal(canonicalizeModel('claude-mega', 'ollama'), 'claude-mega');
  });

  test('fails toward preserving an omitted id', () => {
    assert.equal(canonicalizeModel(undefined, CLAUDE_BACKEND_ID), undefined);
  });
});

describe('claudeContextWindowTokens', () => {
  test('reads the native window and tolerates a launch tag', () => {
    assert.equal(claudeContextWindowTokens('claude-fable-5'), 1_000_000);
    assert.equal(claudeContextWindowTokens('claude-sonnet-4-6[1m]'), 1_000_000);
  });

  test('returns null for unknown or empty ids — never a fabricated default', () => {
    assert.equal(claudeContextWindowTokens('claude-nope'), null);
    assert.equal(claudeContextWindowTokens(''), null);
    assert.equal(claudeContextWindowTokens(undefined), null);
  });
});

describe('familyOf — prefix naming heuristic', () => {
  test('maps the four claude family prefixes', () => {
    assert.equal(familyOf('claude-fable-5'), 'fable');
    assert.equal(familyOf('claude-opus-4-8'), 'opus');
    assert.equal(familyOf('claude-sonnet-5'), 'sonnet');
    assert.equal(familyOf('claude-haiku-4-5'), 'haiku');
  });

  test('returns null for anything that does not look like a claude id', () => {
    assert.equal(familyOf('gpt-5'), null);
    assert.equal(familyOf('claude-unknown'), null);
    assert.equal(familyOf(42), null);
    assert.equal(familyOf(undefined), null);
  });
});

describe('known-* guards and defaultVersion', () => {
  test('isKnownFamily / isKnownTier / isKnownRole truth tables', () => {
    assert.ok(isKnownFamily('opus'));
    assert.ok(!isKnownFamily('gpt'));
    assert.ok(isKnownTier('powerful'));
    assert.ok(!isKnownTier('ultra'));
    assert.ok(isKnownRole('conductor'));
    assert.ok(!isKnownRole('director'));
    assert.ok(!isKnownFamily(undefined));
  });

  test('isKnownVersion / isKnownClaudeModel / defaultVersion', () => {
    assert.ok(isKnownVersion('sonnet', 'claude-sonnet-5'));
    assert.ok(!isKnownVersion('sonnet', 'claude-opus-5'));
    assert.ok(isKnownClaudeModel('claude-opus-4-7'));
    assert.ok(!isKnownClaudeModel('ollama'));
    assert.equal(defaultVersion('haiku'), 'claude-haiku-4-5');
    assert.equal(defaultVersion('nope'), null);
  });
});

describe('managed backends + default bindings', () => {
  test('MANAGED_BACKENDS: claude identity row and ollama template', () => {
    assert.deepEqual(MANAGED_BACKEND_IDS, ['claude', 'ollama']);
    const claude = MANAGED_BACKENDS.find(b => b.id === 'claude');
    assert.equal(claude.template, '');
    assert.equal(claude.managed, true);
    const ollama = MANAGED_BACKENDS.find(b => b.id === 'ollama');
    assert.ok(ollama.template.includes('{model}'), 'ollama template substitutes the model');
    assert.equal(ollama.managed, true);
    assert.equal(CLAUDE_BACKEND_ID, 'claude');
  });

  test('DEFAULT_TIER_BACKEND binds every tier to a known claude model on the claude backend', () => {
    for (const tier of CAPABILITY_TIERS) {
      const b = DEFAULT_TIER_BACKEND[tier.tier];
      assert.equal(b.backend, CLAUDE_BACKEND_ID, `${tier.tier} must bind the identity backend`);
      assert.ok(isKnownClaudeModel(b.model), `${tier.tier} -> '${b.model}' is not a known claude model`);
    }
  });

  test('DEFAULT_ROLE_BINDING binds every built-in role to the powerful tier', () => {
    for (const r of ROLES) {
      const b = DEFAULT_ROLE_BINDING[r.role];
      assert.deepEqual(b, { kind: 'tier', tier: 'powerful' });
      assert.ok(isKnownTier(b.tier));
    }
  });
});
