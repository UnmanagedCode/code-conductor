// src/renewalBoundary.ts: which segments a "Context renewed" divider separates
// (renewalBoundaryAt) and where the pre-renewal transcript is cut
// (renewalCut). Pure — no server, no store, synthetic transcripts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renewalBoundaryAt, renewalCut, NOT_A_RENEWAL_BOUNDARY } from '../src/renewalBoundary.ts';
import { RENEW_HEAD } from './segmentChain.mjs';
import { RENEW_TOOL_WIRE_NAME } from '../src/renewalBoundary.ts';
import {
  preRenewalRecords, postRenewalRecords, postTypedClearRecords, renewRequest, reseedText, prompt, reply, text, steer, queuePair,
  targetedRenewCall, jsonl, RENEW_TOOL,
} from './renewalFixtures.mjs';

const seg = (id, reason, extra = {}) => ({ id, reason, at: '2026-09-01T00:00:00Z', ...extra });
const ids = (segs) => segs.map(s => s.id);

const managedPost = (tag) => jsonl([...RENEW_HEAD, ...postRenewalRecords(tag)]);

test('a divider labelled with the renew segment resolves to its predecessor', () => {
  const b = renewalBoundaryAt([seg('A', 'initial'), seg('B', 'renew')], 'B');
  assert.equal(b.pre.id, 'A');
  assert.deepEqual(ids(b.post), ['B']);
});

test('a divider labelled with a prune copy resolves through the prune run', () => {
  const b = renewalBoundaryAt([seg('A', 'initial'), seg('B', 'renew'), seg('C', 'prune')], 'C');
  assert.equal(b.pre.id, 'A');
  assert.deepEqual(ids(b.post), ['B', 'C']);
});

test('a prune before the renewal makes the pruned copy the pre segment', () => {
  const b = renewalBoundaryAt([seg('A', 'initial'), seg('A2', 'prune'), seg('B', 'renew')], 'B');
  assert.equal(b.pre.id, 'A2');
  assert.deepEqual(ids(b.post), ['B']);
});

test('the post run keeps a tombstone between the renew entry and the end', () => {
  const b = renewalBoundaryAt([seg('A', 'initial'), seg('B', 'renew'), seg('C', 'prune', { dropped: true }), seg('D', 'prune')], 'D');
  assert.equal(b.pre.id, 'A');
  assert.deepEqual(ids(b.post), ['B', 'C', 'D']);
});

test('an initial, unknown or prune-only label is refused 400 NOT_A_RENEWAL_BOUNDARY', () => {
  const chain = [seg('A', 'initial'), seg('P', 'prune'), seg('B', 'renew')];
  for (const label of ['A', 'nope', 'P']) {
    assert.throws(() => renewalBoundaryAt(chain, label), (e) => {
      assert.equal(e.statusCode, 400, label);
      assert.equal(e.code, NOT_A_RENEWAL_BOUNDARY, label);
      return true;
    });
  }
  assert.throws(() => renewalBoundaryAt([], 'A'), { code: NOT_A_RENEWAL_BOUNDARY });
});

test('the cut lands before the request that called renew_session; a declined request survives', () => {
  const cut = renewalCut(jsonl(preRenewalRecords('s')), managedPost('s'));
  assert.deepEqual(cut, { userMessageIndex: 2, text: renewRequest('s') });
});

test('a steer inside the arming turn does not move the cut', () => {
  const pre = preRenewalRecords('s', { betweenToolSearchAndRenew: [steer('s-steer', 'also check the tests')] });
  assert.deepEqual(renewalCut(jsonl(pre), managedPost('s')), { userMessageIndex: 2, text: renewRequest('s') });
});

test('a prompt that opened a turn after the renewal was armed is cut with it', () => {
  const pre = preRenewalRecords('s');
  const clearAt = pre.length - queuePair().length;
  pre.splice(clearAt, 0, prompt('s-late', 'a prompt sent while the renewal was deferred'), reply('s-late-a', [text('ok')]));
  assert.deepEqual(renewalCut(jsonl(pre), managedPost('s')), { userMessageIndex: 2, text: renewRequest('s') });
});

test('a managed renewal with no renew_session tool_use cuts before the last turn opener', () => {
  const pre = [
    prompt('r-u0', 'r brief'),
    reply('r-a0', [text('done')]),
    prompt('r-u1', renewRequest('r')),
    steer('r-steer', 'a steer in the same turn'),
    reply('r-a1', [text('renewing from run_code')]),
    ...queuePair(),
  ];
  assert.deepEqual(renewalCut(jsonl(pre), managedPost('r')), { userMessageIndex: 1, text: renewRequest('r') });
});

test('a typed /clear (no reseed) has no cut', () => {
  assert.equal(renewalCut(jsonl(preRenewalRecords('t')), jsonl([...RENEW_HEAD, ...postTypedClearRecords('t')])), null);
});

test('a managed renewal whose reseed never landed has no cut', () => {
  assert.equal(renewalCut(jsonl(preRenewalRecords('n')), jsonl(RENEW_HEAD)), null);
  assert.equal(renewalCut(jsonl(preRenewalRecords('n')), ''), null);
});

test('a managed renewal with no turn opener before the call is refused 409', () => {
  const pre = [steer('x-steer', 'only a steer'), ...preRenewalRecords('x').slice(5)];
  assert.throws(() => renewalCut(jsonl(pre), managedPost('x')), (e) => {
    assert.equal(e.statusCode, 409);
    assert.match(e.message, /cannot locate the renewal request/);
    return true;
  });
});

test('the anchor name is the wire name the CLI records', () => {
  assert.equal(RENEW_TOOL_WIRE_NAME, RENEW_TOOL);
});

test('a targeted renew_session call in a later deferred turn does not move the cut', () => {
  const pre = preRenewalRecords('a');
  const clearAt = pre.length - queuePair().length;
  pre.splice(clearAt, 0, prompt('a-late', 'renew the worker too'), ...targetedRenewCall('a'), reply('a-late-a', [text('asked it')]));
  assert.deepEqual(renewalCut(jsonl(pre), managedPost('a')), { userMessageIndex: 2, text: renewRequest('a') });
});

test('an earlier targeted renew_session call is no anchor: a run_code renewal still cuts before the last opener', () => {
  const pre = [
    prompt('b-u0', 'b brief'),
    ...targetedRenewCall('b'),
    reply('b-a0', [text('asked the worker to renew')]),
    prompt('b-u1', renewRequest('b')),
    reply('b-a1', [text('renewing from run_code')]),
    ...queuePair(),
  ];
  assert.deepEqual(renewalCut(jsonl(pre), managedPost('b')), { userMessageIndex: 1, text: renewRequest('b') });
});

test('a prompt that lands in the new segment before the reseed still marks the renewal managed', () => {
  const post = jsonl([
    ...RENEW_HEAD,
    prompt('c-early', 'a prompt sent between the clear and the reseed'),
    reply('c-early-a', [text('ok')]),
    prompt('c-seed', reseedText('c')),
    reply('c-seed-a', [text('resumed')]),
  ]);
  assert.deepEqual(renewalCut(jsonl(preRenewalRecords('c')), post), { userMessageIndex: 2, text: renewRequest('c') });
});

test('a steer in an earlier turn counts in the cut\'s ordinal space', () => {
  const pre = preRenewalRecords('d', { afterDeclined: [steer('d-steer', 'a steer while the declined request ran')] });
  assert.deepEqual(renewalCut(jsonl(pre), managedPost('d')), { userMessageIndex: 3, text: renewRequest('d') });
});
