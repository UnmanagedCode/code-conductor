// ExecOutputCollector's BYTE MODE (`encoding: 'buffer'`), which both `exec`
// implementations share (src/systems/execCollector.ts).
//
// What it owes a caller: the retained bytes are the bytes the command wrote —
// no decoder in the way — under the SAME fence and head cap the UTF-8 mode
// applies; the strings stay empty; and the character-level options that have
// no meaning over bytes are refused rather than half-applied.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecOutputCollector } from '../src/systems/execCollector.ts';

const done = (c, code = 0, extra = {}) => c.result(code, { timedOut: false, durationMs: 1, ...extra });

// PINS: byte mode retains raw bytes per stream — a multibyte character split
// across two chunks, a NUL and a 0xff come back exact — and the strings are ''.
test('buffer mode: split multibyte, NUL and 0xff come back byte-exact, per stream', () => {
  const c = new ExecOutputCollector({ encoding: 'buffer' }, () => {});
  const euro = Buffer.from('€', 'utf8');
  c.push('out', euro.subarray(0, 1));
  c.push('err', Buffer.from([0xff, 0x00]));
  c.push('out', euro.subarray(1));
  const r = done(c);
  assert.deepEqual(r.stdoutBytes, euro);
  assert.deepEqual(r.stderrBytes, Buffer.from([0xff, 0x00]));
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(r.output, '');
});

// PINS: the maxBufferBytes fence applies to byte mode exactly as to strings —
// the overflow flag, the first N bytes retained, and the kill callback fired.
test('buffer mode: maxBufferBytes fences — first N bytes kept, flagged, killed', () => {
  let killed = 0;
  const c = new ExecOutputCollector({ encoding: 'buffer', maxBufferBytes: 5 }, () => { killed++; });
  c.push('out', Buffer.from('abc'));
  c.push('out', Buffer.from('defgh'));
  c.push('out', Buffer.from('ij'));
  const r = done(c, 0);
  assert.equal(killed, 1);
  assert.equal(r.outputOverflowed, true);
  assert.equal(r.code, 1, 'an overflow is a failure');
  assert.deepEqual(r.stdoutBytes, Buffer.from('abcde'));
});

// PINS: the head cap applies in byte mode: retention stops once the budget is
// met (overshooting by at most the crossing chunk) and the result is truncated.
test('buffer mode: headCapBytes clips retention and marks truncated', () => {
  const c = new ExecOutputCollector({ encoding: 'buffer', headCapBytes: 4 }, () => {});
  c.push('out', Buffer.from('ab'));
  c.push('err', Buffer.from('cde'));
  c.push('out', Buffer.from('zz'));
  const r = done(c);
  assert.deepEqual(r.stdoutBytes, Buffer.from('ab'));
  assert.deepEqual(r.stderrBytes, Buffer.from('cde'));
  assert.equal(r.truncated, true);
});

// PINS: a never-started command in byte mode still carries Buffers (empty), and
// its diagnostic still lands in the string fields.
test('buffer mode: a spawn error yields empty Buffers and the message in stderr', () => {
  const c = new ExecOutputCollector({ encoding: 'buffer' }, () => {});
  const r = done(c, 1, { spawnError: 'spawn nope ENOENT' });
  assert.deepEqual(r.stdoutBytes, Buffer.alloc(0));
  assert.deepEqual(r.stderrBytes, Buffer.alloc(0));
  assert.equal(r.stderr, 'spawn nope ENOENT');
});

// PINS: `cap` and `onChunk` combined with byte mode are cc's bug and throw at
// construction.
test('buffer mode refuses cap and onChunk at construction', () => {
  assert.throws(() => new ExecOutputCollector({ encoding: 'buffer', cap: 10 }, () => {}), /cap/);
  assert.throws(() => new ExecOutputCollector({ encoding: 'buffer', onChunk: () => {} }, () => {}), /onChunk/);
});

// PINS: the default mode is unchanged — strings decoded, no byte fields at all.
test('utf8 mode (default and explicit) decodes strings and carries no byte fields', () => {
  for (const opts of [{}, { encoding: 'utf8' }]) {
    const c = new ExecOutputCollector(opts, () => {});
    const euro = Buffer.from('€', 'utf8');
    c.push('out', euro.subarray(0, 2));
    c.push('out', euro.subarray(2));
    const r = done(c);
    assert.equal(r.stdout, '€');
    assert.equal('stdoutBytes' in r, false);
    assert.equal('stderrBytes' in r, false);
  }
});
