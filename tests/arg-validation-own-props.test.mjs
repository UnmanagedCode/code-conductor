// validateArgs reads a schema's properties and an argument object's keys as own
// properties only: an inherited name (`constructor`, `toString`, …) is neither a
// declared property nor a supplied argument.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../src/mcp/argValidation.ts';

const schema = (extra = {}) => ({ type: 'object', properties: { a: { type: 'string' } }, ...extra });

// PINS: an argument named like an Object.prototype member is "unexpected", not matched to an inherited schema property.
test('an argument named after an inherited property is an unexpected argument', () => {
  for (const k of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const args = JSON.parse(`{"a":"x","${k}":"y"}`);
    assert.match(validateArgs(schema(), args, 't'), new RegExp(`^unexpected argument '${k}'`), k);
  }
  assert.equal(validateArgs(schema(), { a: 'x' }, 't'), null);
});

// PINS: `required` is satisfied only by an own key; an inherited name in `required` is missing from `{}`.
test('a required inherited name is not satisfied by an empty object', () => {
  for (const k of ['toString', 'constructor']) {
    assert.equal(validateArgs(schema({ required: [k] }), {}, 't'), `missing required argument: ${k}`, k);
  }
  assert.equal(validateArgs(schema({ required: ['a'] }), { a: 'x' }, 't'), null);
});
