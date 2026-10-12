// public/closeAction.js: the × of a session row / strip entry is ONE step down
// from where the session is — a live persistent session is stopped (transcript
// kept), a live temp or not-live one is archived — and which stops ask first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeActionOf, stopNeedsConfirm } from '../public/closeAction.js';

test('closeActionOf: one step down — stop only a live persistent session', async (t) => {
  const cases = [
    ['live idle persistent', { instanceId: 'i', status: 'idle', temp: false }, 'stop'],
    ['live busy persistent', { instanceId: 'i', status: 'turn', temp: false }, 'stop'],
    ['live temp', { instanceId: 'i', status: 'idle', temp: true }, 'archive'],
    ['exited persistent', { instanceId: 'i', status: 'exited', temp: false }, 'archive'],
    ['crashed persistent', { instanceId: 'i', status: 'crashed', temp: false }, 'archive'],
    ['disk row, no instance', { instanceId: null, status: null, temp: false }, 'archive'],
    ['instance id but no status', { instanceId: 'i', status: null, temp: false }, 'archive'],
    ['status but no instance id (the row renders offline)', { instanceId: null, status: 'offline', temp: false }, 'archive'],
  ];
  for (const [name, input, want] of cases) {
    await t.test(name, () => assert.equal(closeActionOf(input), want));
  }
});

test('stopNeedsConfirm: idle is the only status that stops silently', async (t) => {
  assert.equal(stopNeedsConfirm('idle'), false);
  for (const s of ['turn', 'running', 'spawning']) {
    await t.test(s, () => assert.equal(stopNeedsConfirm(s), true));
  }
});
