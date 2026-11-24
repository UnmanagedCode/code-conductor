// The shared size-capped append for cc-owned logs (src/logRotation.ts). Temp
// files only; no real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { appendRotating } from '../src/logRotation.ts';

// `sub/` does not exist yet, so every test also covers the missing parent.
async function tmp() {
  const dir = await mkdtemp('log-rotation-');
  return { dir, file: path.join(dir, 'sub', 'events.log'), previous: path.join(dir, 'sub', 'events.log.1') };
}
const read = (p) => fs.readFile(p, 'latin1');
const seedFile = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const B = (s) => Buffer.from(s, 'latin1');

// PINS: the cap is strict ("over", not "at"), checked BEFORE the append, and the
// rotation is a rename to `previous`.
// DIES UNDER: `>=` for `>`; checking after the append; dropping the rotation;
// rotating to the wrong path.
test('appendRotating: a file exactly at the cap is appended in place; one byte over rotates first', async () => {
  const { file, previous } = await tmp();
  const seed = 'row-aaaa\nrow-bbbb\n';
  const maxBytes = seed.length;
  await seedFile(file, seed);
  await appendRotating(file, B('B-row\n'), { maxBytes, previous });
  await assert.rejects(fs.access(previous), { code: 'ENOENT' });
  assert.equal(await read(file), seed + 'B-row\n');
  await appendRotating(file, B('C-row\n'), { maxBytes, previous });
  assert.equal(await read(previous), seed + 'B-row\n');
  assert.equal(await read(file), 'C-row\n');
});

// PINS: one generation — the previous generation is overwritten, never appended
// to, and no `.2` appears.
// DIES UNDER: appending to `previous` rather than renaming over it; adding
// generations.
test('appendRotating: rotation keeps one generation and overwrites it', async () => {
  const { file, previous } = await tmp();
  for (const r of ['r1\n', 'r2\n', 'r3\n']) await appendRotating(file, B(r), { maxBytes: 1, previous });
  assert.equal(await read(previous), 'r2\n');
  assert.equal(await read(file), 'r3\n');
  await assert.rejects(fs.access(`${previous}.2`), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(path.dirname(file), 'events.log.2')), { code: 'ENOENT' });
});

// PINS: a missing parent and file are created, and a missing file is not "over
// the cap" (nothing to rotate).
// DIES UNDER: dropping the mkdir; treating ENOENT as over the cap; rethrowing
// ENOENT from stat.
test('appendRotating: creates a missing parent dir and file; a missing file is never rotated', async () => {
  const { file, previous } = await tmp();
  await appendRotating(file, B('a body longer than the cap\n'), { maxBytes: 4, previous });
  assert.equal(await read(file), 'a body longer than the cap\n');
  await assert.rejects(fs.access(previous), { code: 'ENOENT' });
});

// PINS: calls on one file run one at a time, in call order: every call after the
// first sees the earlier call's write. Unserialised, all eight stats see ENOENT
// and the file holds all eight rows.
// DIES UNDER: removing the keyed queue; keying it on something other than the
// resolved path (a fresh queue per call).
test('appendRotating: concurrent calls on one file run one at a time, in call order', async () => {
  const { file, previous } = await tmp();
  await Promise.all(Array.from({ length: 8 }, (_, i) => appendRotating(file, B(`row-${i}\n`), { maxBytes: 1, previous })));
  assert.equal(await read(file), 'row-7\n');
  assert.equal(await read(previous), 'row-6\n');
});

// PINS: a concurrent burst across ONE rotation loses and duplicates no row, and
// the new file starts at the first row's first byte. An invariant pin for the
// no-lost/no-duplicated-rows claim; NOT the queue's killer (the in-order test
// above is).
// DIES UNDER: losing, duplicating or splitting a row across the rotation.
test('appendRotating: a concurrent burst across one rotation loses and duplicates no row', async () => {
  const { file, previous } = await tmp();
  const seed = Array.from({ length: 10 }, (_, i) => `seed-row-${i}\n`).join('');
  await seedFile(file, seed);
  const maxBytes = seed.length - 1;
  const rows = Array.from({ length: 8 }, (_, i) => `row-${i}\n`);
  await Promise.all(rows.map((r) => appendRotating(file, B(r), { maxBytes, previous })));
  assert.equal(await read(previous), seed);
  assert.equal(await read(file), rows.join(''));
});

// PINS: a failed rotation rejects to ITS caller and appends nothing; the next
// call on the same file still runs.
// DIES UNDER: swallowing the rename error; appending despite a failed rotation;
// a rejection that blocks the queue.
test('appendRotating: a failed rotation rejects to its caller and the next call on the file still runs', async () => {
  const { dir, file, previous } = await tmp();
  await seedFile(file, 'seed-row\n');
  const notADir = path.join(dir, 'regular');
  await fs.writeFile(notADir, 'x');
  const bad = path.join(notADir, 'events.log.1'); // rename -> ENOTDIR
  await assert.rejects(appendRotating(file, B('lost\n'), { maxBytes: 1, previous: bad }));
  assert.equal(await read(file), 'seed-row\n');
  await appendRotating(file, B('next\n'), { maxBytes: 1, previous });
  assert.equal(await read(previous), 'seed-row\n');
  assert.equal(await read(file), 'next\n');
});
