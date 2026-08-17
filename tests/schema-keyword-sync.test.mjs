// Pins the contract audit finding F6 called its worst case: plugins/manifest's
// ALLOWED_PROP_KEYS used to re-encode BY HAND the keyword list mcp/server's
// checkConstraints enforces, so adding a keyword to one silently broke the
// other. Both now derive from VALIDATED_CONSTRAINT_KEYS in mcp/argValidation.ts.
//
// The point of this file is that it is NOT a set-equality tautology. Asserting
// `ALLOWED_PROP_KEYS === new Set([...VALIDATED, ...DESCRIPTIVE])` would only
// restate the line that computes it. Instead each keyword is driven through the
// REAL validator with an argument that violates it, so a keyword listed but not
// actually enforced fails here — which is the dangerous direction (a plugin
// author is told a constraint works when nothing checks it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateArgs, VALIDATED_CONSTRAINT_KEYS, DESCRIPTIVE_PROP_KEYS, ALLOWED_PROP_KEYS,
} from '../src/mcp/argValidation.ts';
import { validateManifest } from '../src/plugins/manifest.ts';

// For each declared keyword: a property schema using it, and an argument value
// that must be refused BECAUSE of it.
const VIOLATIONS = {
  type:      { schema: { type: 'string' },            bad: 42 },
  enum:      { schema: { enum: ['a', 'b'] },          bad: 'c' },
  minLength: { schema: { type: 'string', minLength: 3 }, bad: 'ab' },
  maxLength: { schema: { type: 'string', maxLength: 2 }, bad: 'abc' },
  pattern:   { schema: { type: 'string', pattern: '^x+$' }, bad: 'y' },
  minimum:   { schema: { type: 'number', minimum: 5 }, bad: 4 },
  maximum:   { schema: { type: 'number', maximum: 5 }, bad: 6 },
  items:     { schema: { type: 'array', items: { type: 'string' } }, bad: [1] },
};

test('every keyword in VALIDATED_CONSTRAINT_KEYS is actually enforced', () => {
  for (const keyword of VALIDATED_CONSTRAINT_KEYS) {
    const spec = VIOLATIONS[keyword];
    assert.ok(spec, `no violation case written for '${keyword}' — add one to this test`);
    const schema = { type: 'object', properties: { v: spec.schema } };

    const violation = validateArgs(schema, { v: spec.bad }, 'tool');
    assert.ok(violation,
      `'${keyword}' is listed in VALIDATED_CONSTRAINT_KEYS but checkConstraints did not refuse ${JSON.stringify(spec.bad)} — the manifest allow-list would be advertising a constraint nothing checks`);
  }
});

test('a conforming value passes each of those same schemas', () => {
  // Guards the other direction: the cases above must fail for the RIGHT reason,
  // not because the schema is refused outright.
  const ok = {
    type: 'hello', enum: 'a', minLength: 'abc', maxLength: 'ab',
    pattern: 'xxx', minimum: 5, maximum: 5, items: ['s'],
  };
  for (const keyword of VALIDATED_CONSTRAINT_KEYS) {
    const schema = { type: 'object', properties: { v: VIOLATIONS[keyword].schema } };
    assert.equal(validateArgs(schema, { v: ok[keyword] }, 'tool'), null,
      `a conforming value was refused for '${keyword}'`);
  }
});

test('descriptive keywords are accepted and constrain nothing', () => {
  for (const keyword of DESCRIPTIVE_PROP_KEYS) {
    assert.ok(ALLOWED_PROP_KEYS.has(keyword));
    const schema = { type: 'object', properties: { v: { type: 'string', [keyword]: 'anything' } } };
    assert.equal(validateArgs(schema, { v: 'ok' }, 'tool'), null);
  }
});

// The manifest side of the same contract.
function manifestWithPropKeys(propSchema) {
  return validateManifest({
    id: 'p', name: 'P', version: '1.0.0', pluginApi: 1,
    mcp: {
      endpoint: 'http://127.0.0.1:1/mcp',
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: { v: propSchema } } }],
    },
  });
}

test('the manifest accepts exactly the derived allow-list', () => {
  for (const keyword of ALLOWED_PROP_KEYS) {
    // A shape that is valid for every keyword (items needs an object).
    const value = keyword === 'items' ? { type: 'string' } : keyword === 'enum' ? ['a'] : 'x';
    const r = manifestWithPropKeys({ type: 'string', [keyword]: value });
    assert.ok(!('errors' in r) || !r.errors.some(e => e.includes(`unsupported key '${keyword}'`)),
      `manifest rejected allow-listed keyword '${keyword}': ${JSON.stringify(r.errors ?? [])}`);
  }
});

test('the manifest still rejects a keyword outside the allow-list', () => {
  // `multipleOf` is real JSON Schema that checkConstraints does NOT implement,
  // so accepting it would be exactly the silent-no-op failure mode.
  assert.ok(!ALLOWED_PROP_KEYS.has('multipleOf'));
  const r = manifestWithPropKeys({ type: 'number', multipleOf: 2 });
  assert.ok('errors' in r, 'a schema using an unenforced keyword must be refused');
  assert.ok(r.errors.some(e => e.includes("unsupported key 'multipleOf'")),
    `expected an unsupported-key error, got ${JSON.stringify(r.errors)}`);
});

test('the manifest still rejects the forbidden combinators', () => {
  for (const key of ['$ref', 'oneOf', 'anyOf', 'allOf', 'not']) {
    const r = manifestWithPropKeys({ type: 'string', [key]: {} });
    assert.ok('errors' in r && r.errors.some(e => e.includes(`unsupported '${key}'`)),
      `combinator '${key}' must stay refused; got ${JSON.stringify(r.errors ?? [])}`);
  }
});
