// Migration 0014: backfill the `cache_miss` flag onto pre-existing
// costs.jsonl rows.
//
// Cache-miss detection became DECISIVE (captured live from a turn's first
// message_start; see src/instances.js) and each new turn_end row now persists
// `cache_miss`. Rows written before that change have only the per-turn SUMMED
// usage, so they can't be re-derived decisively. This migration applies the
// ORIGINAL session-relative heuristic — the one that previously ran at read
// time in src/costTracking.js — ONCE, permanently, to stamp `cache_miss` on
// those legacy rows. This is the heuristic's permanent home.
//
// Heuristic: group rows by sessionId (rows with no sessionId are excluded —
// no conversation lineage), sort by ts, exclude the first turn per session,
// and flag a non-first row when its cache_creation_tokens is a spike:
// `cache_creation_tokens >= max(50000, 4 × median(non-first creation tokens))`.
// Every other row (first-turn, null-session, single-row session, below-
// threshold) is flagged false.
//
// The field was originally named `cache_flush`; a row that still carries that
// OLD key is a decisive live-captured verdict from before the rename, so it is
// renamed in place (value preserved, key deleted) rather than recomputed —
// recomputing would clobber a real verdict with a guess. Only rows with
// NEITHER key run through the heuristic. Rows that already carry `cache_miss`
// are left untouched. Unparseable lines are preserved verbatim.
//
// Scope: a single file in the central store, `<root>/.code-conductor/costs.jsonl`.
// Idempotent: a no-op once the file is absent, or every row has `cache_miss`
// and no row still carries the old `cache_flush` key.
//
// Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0014-backfill-cache-miss-flags';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const MISS_ABS_FLOOR = 50000;
const MISS_K = 4;

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Returns a Set of row objects (by reference) that the heuristic flags as a
// cache miss. Only session-attributed, non-first, spike rows qualify.
function heuristicMissRows(rows) {
  const bySession = new Map();
  for (const r of rows) {
    if (r.sessionId == null) continue;
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }
  const missed = new Set();
  for (const sessionRows of bySession.values()) {
    if (sessionRows.length < 2) continue; // only a cold start, nothing to evaluate
    sessionRows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const nonFirst = sessionRows.slice(1);
    const threshold = Math.max(
      MISS_ABS_FLOOR,
      MISS_K * median(nonFirst.map(r => r.cache_creation_tokens ?? 0)),
    );
    for (const r of nonFirst) {
      if ((r.cache_creation_tokens ?? 0) >= threshold) missed.add(r);
    }
  }
  return missed;
}

async function writeTextAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const file = path.join(projectsRoot, '.code-conductor', 'costs.jsonl');

  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { applied: false };
    throw e;
  }

  // Parse line-by-line, preserving unparseable lines verbatim so no data is
  // destroyed. `obj:null` marks a passthrough line.
  const lines = raw.split('\n').filter(Boolean);
  const entries = lines.map(line => {
    try {
      const obj = JSON.parse(line);
      return (obj && typeof obj === 'object') ? { obj } : { raw: line };
    } catch {
      return { raw: line };
    }
  });

  const parsedRows = entries.filter(e => e.obj).map(e => e.obj);
  // Already-applied check: no-op once every row has cache_miss and none still
  // carries the old cache_flush key.
  const needsWork = parsedRows.some(r => !('cache_miss' in r) || ('cache_flush' in r));
  if (!needsWork) return { applied: false };

  const missed = heuristicMissRows(parsedRows);

  let rowsRenamed = 0;
  let rowsFlagged = 0;
  for (const r of parsedRows) {
    if ('cache_flush' in r) {
      r.cache_miss = r.cache_flush;
      delete r.cache_flush;
      rowsRenamed += 1;
      continue;
    }
    if ('cache_miss' in r) continue; // already decisive under the new name
    const isMiss = missed.has(r);
    r.cache_miss = isMiss;
    if (isMiss) rowsFlagged += 1;
  }

  const out = entries.map(e => e.obj ? JSON.stringify(e.obj) : e.raw).join('\n') + '\n';
  await writeTextAtomic(file, out);
  log(`  ✓ cache_miss on ${parsedRows.length} cost row${parsedRows.length === 1 ? '' : 's'} (${rowsRenamed} renamed from cache_flush, ${rowsFlagged} heuristically flagged) in ${file}`);
  return { applied: true, summary: { rowsTotal: parsedRows.length, rowsRenamed, rowsFlagged } };
}
