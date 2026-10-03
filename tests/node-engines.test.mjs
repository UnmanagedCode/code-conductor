// The boot warning when the running Node does not satisfy package.json's
// engines.node (src/nodeEngines.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeEnginesMismatch } from '../src/nodeEngines.ts';

test('a satisfying version yields no warning', () => {
  assert.equal(nodeEnginesMismatch('24.0.0', '>=24'), null);
  assert.equal(nodeEnginesMismatch('25.1.0', '>=24.2'), null);
  assert.equal(nodeEnginesMismatch('24.2.0', '>=24.2'), null);
});

test('an unsatisfying version names both values and says self-update never updates Node', () => {
  const msg = nodeEnginesMismatch('22.18.0', '>=24');
  assert.match(msg, /22\.18\.0/);
  assert.match(msg, />=24/);
  assert.match(msg, /self-update never updates Node/);
  assert.match(nodeEnginesMismatch('24.1.9', '>=24.2'), /24\.1\.9/);
});

test('a range shape the check does not understand warns that it cannot check', () => {
  assert.match(nodeEnginesMismatch('24.0.0', '^24'), /cannot read/);
});

test('package.json\'s engines range is a shape the check understands, and this Node satisfies it', () => {
  const range = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node;
  assert.equal(nodeEnginesMismatch(process.versions.node, range), null);
});
