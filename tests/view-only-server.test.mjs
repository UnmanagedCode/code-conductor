// CC_VIEW_ONLY: entryStartOptions reads it, and GET /api/health carries it on the
// same `capabilities` bag as the platform flags (not a Platform capability).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryStartOptions } from '../server.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { bootServer } from './helpers.mjs';

test('entryStartOptions reads CC_VIEW_ONLY=1 only', () => {
  assert.equal(entryStartOptions({ CC_VIEW_ONLY: '1' }).viewOnly, true);
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
    assert.equal(entryStartOptions({ CC_VIEW_ONLY: v }).viewOnly, false, JSON.stringify(v));
  }
});

test('health carries capabilities.viewOnly under the flag', async () => {
  const { baseUrl, close } = await bootServer({ viewOnly: true });
  try {
    const { capabilities } = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(capabilities.viewOnly, true);
    for (const [k, v] of Object.entries(hostPlatform.capabilities)) assert.equal(capabilities[k], v, k);
  } finally { await close(); }
});

test('health without the flag is unchanged', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const { capabilities } = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.deepEqual(capabilities, hostPlatform.capabilities);
    assert.equal('viewOnly' in capabilities, false);
  } finally { await close(); }
});
