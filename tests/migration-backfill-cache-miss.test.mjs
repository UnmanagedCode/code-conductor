// Unit tests for migration 0014 (backfill cache_miss onto legacy costs.jsonl
// rows via the original session-relative heuristic). Verifies backfill
// correctness, idempotency (second run is a no-op), rename-in-place of the
// old cache_flush key (value preserved, not recomputed), and the absent-file
// no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0014 from '../migrations/0014-backfill-cache-miss-flags.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-backfill-miss-'));
}

function costsFile(root) {
  return path.join(root, '.code-conductor', 'costs.jsonl');
}

async function writeRows(root, rows) {
  const file = costsFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

async function readRows(file) {
  const raw = await fs.readFile(file, 'utf8');
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const T = (s) => new Date('2026-06-01T00:00:00Z').getTime() + s * 1000;
const filler = { project: 'p', model: 'm', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };

test('backfills cache_miss via the heuristic; first-turn / null / normal not flagged', async () => {
  const root = await mkTmp();
  const rows = [
    // s1 — huge FIRST turn must NOT be flagged (first-turn exclusion).
    { ts: T(0), sessionId: 's1', cache_creation_tokens: 200000, ...filler },
    { ts: T(1), sessionId: 's1', cache_creation_tokens: 5000,   ...filler },
    { ts: T(2), sessionId: 's1', cache_creation_tokens: 6000,   ...filler },

    // s2 — genuine spike: non-first median=4000, threshold=max(50000,16000)=50000; 200000 flagged.
    { ts: T(3), sessionId: 's2', cache_creation_tokens: 3000,   ...filler },
    { ts: T(4), sessionId: 's2', cache_creation_tokens: 4000,   ...filler },
    { ts: T(5), sessionId: 's2', cache_creation_tokens: 5000,   ...filler },
    { ts: T(6), sessionId: 's2', cache_creation_tokens: 200000, ...filler },

    // s3 — normal extension, nothing flagged: median=21000, threshold=84000; all below.
    { ts: T(7),  sessionId: 's3', cache_creation_tokens: 3000,  ...filler },
    { ts: T(8),  sessionId: 's3', cache_creation_tokens: 20000, ...filler },
    { ts: T(9),  sessionId: 's3', cache_creation_tokens: 22000, ...filler },
    { ts: T(10), sessionId: 's3', cache_creation_tokens: 25000, ...filler },

    // Null sessionId — excluded entirely; must be flagged false.
    { ts: T(11), sessionId: null, cache_creation_tokens: 999999, ...filler },
  ];
  const file = await writeRows(root, rows);

  const res = await m0014.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.rowsTotal, 12);
  assert.equal(res.summary.rowsRenamed, 0, 'no row carried the old cache_flush key');
  assert.equal(res.summary.rowsFlagged, 1, 'only the s2 spike');

  const out = await readRows(file);
  assert.ok(out.every(r => 'cache_miss' in r), 'every row has a cache_miss flag');
  assert.ok(out.every(r => !('cache_flush' in r)), 'no row keeps the old cache_flush key');
  // s1 first turn (index 0) false, s2 spike (index 6) true, everything else false.
  assert.equal(out[0].cache_miss, false, 's1 huge first turn not flagged');
  assert.equal(out[6].cache_miss, true, 's2 spike flagged');
  assert.equal(out.filter(r => r.cache_miss === true).length, 1);
  assert.equal(out[11].cache_miss, false, 'null-sessionId row not flagged');
});

test('idempotent: a second run is a no-op and leaves the file byte-identical', async () => {
  const root = await mkTmp();
  const file = await writeRows(root, [
    { ts: T(0), sessionId: 's1', cache_creation_tokens: 1000,   ...filler },
    { ts: T(1), sessionId: 's1', cache_creation_tokens: 200000, ...filler },
  ]);

  const first = await m0014.run({ root, log: () => {} });
  assert.equal(first.applied, true);
  const afterFirst = await fs.readFile(file, 'utf8');

  const second = await m0014.run({ root, log: () => {} });
  assert.equal(second.applied, false, 'every row already has cache_miss and none carries cache_flush');
  const afterSecond = await fs.readFile(file, 'utf8');
  assert.equal(afterSecond, afterFirst, 'file unchanged on the second run');
});

test('renames the old cache_flush key in place; value preserved, NOT recomputed', async () => {
  const root = await mkTmp();
  const file = await writeRows(root, [
    // A decisive row captured live BEFORE the field was renamed — carries the
    // OLD cache_flush key with a false verdict, even though its creation would
    // otherwise be a heuristic spike. Renaming must preserve the false value,
    // not recompute it to true.
    { ts: T(0), sessionId: 's1', cache_flush: false, cache_creation_tokens: 500000, ...filler },
    // Legacy rows lacking any flag — heuristic applies. Non-first median over
    // {4000,300000} = 152000; threshold=max(50000,608000)=608000 → neither flagged.
    { ts: T(1), sessionId: 's2', cache_creation_tokens: 4000,   ...filler },
    { ts: T(2), sessionId: 's2', cache_creation_tokens: 300000, ...filler },
  ]);

  const res = await m0014.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.rowsRenamed, 1, 'the s1 row carried the old key');
  assert.equal(res.summary.rowsFlagged, 0, 'neither s2 row crosses the heuristic threshold');
  const out = await readRows(file);
  assert.equal(out[0].cache_miss, false, 'pre-set decisive value preserved (not re-derived to true)');
  assert.ok(!('cache_flush' in out[0]), 'old key removed after rename');
  assert.ok('cache_miss' in out[1] && 'cache_miss' in out[2], 'legacy rows filled by the heuristic');
});

test('idempotent no-op when costs.jsonl is absent', async () => {
  const root = await mkTmp();
  const res = await m0014.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});
