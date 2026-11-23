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

// Invariant: a headless-family server advertises its focus cell on health, live
// (the cell is read per request); an ordinary server's health has no `focus` key.
test('health carries the focus cell, and follows it', async () => {
  const focus = { sessionId: null };
  const { baseUrl, close } = await bootServer({ focus });
  try {
    assert.deepEqual((await (await fetch(`${baseUrl}/api/health`)).json()).focus, { sessionId: null });
    focus.sessionId = 'sess-1';
    assert.deepEqual((await (await fetch(`${baseUrl}/api/health`)).json()).focus, { sessionId: 'sess-1' });
  } finally { await close(); }
});

test('health without a focus cell has no focus key', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    assert.equal('focus' in await (await fetch(`${baseUrl}/api/health`)).json(), false);
  } finally { await close(); }
});

// Invariant: a replay server refuses session creation over REST with the replay code.
test('a replay server answers POST /api/instances 409 VIEW_REPLAY_NO_LAUNCH', async () => {
  const { baseUrl, close } = await bootServer({ replay: true });
  try {
    const res = await fetch(`${baseUrl}/api/instances`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'VIEW_REPLAY_NO_LAUNCH');
  } finally { await close(); }
});
