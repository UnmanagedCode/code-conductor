// Migration 0014: backfill the `cache_flush` flag onto pre-existing
// costs.jsonl rows.
//
// Cache-flush detection became DECISIVE (captured live from a turn's first
// message_start; see src/instances.js) and each new turn_end row now persists
// `cache_flush`. Rows written before that change have only the per-turn SUMMED
// usage, so they can't be re-derived decisively. This migration applies the
// ORIGINAL session-relative heuristic — the one that previously ran at read
// time in src/costTracking.js — ONCE, permanently, to stamp `cache_flush` on
// those legacy rows. This is the heuristic's permanent home.
//
// Heuristic: group rows by sessionId (rows with no sessionId are excluded —
// no conversation lineage), sort by ts, exclude the first turn per session,
// and flag a non-first row when its cache_creation_tokens is a spike:
// `cache_creation_tokens >= max(50000, 4 × median(non-first creation tokens))`.
// Every other row (first-turn, null-session, single-row session, below-
// threshold) is flagged false. Rows that ALREADY carry a decisive `cache_flush`
// are left untouched; unparseable lines are preserved verbatim.
//
// Scope: a single file in the central store, `<root>/.code-conductor/costs.jsonl`.
// Idempotent: a no-op once the file is absent or every row already has the flag.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0014-backfill-cache-flush-flags';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const FLUSH_ABS_FLOOR = 50000;
const FLUSH_K = 4;

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Returns a Set of row objects (by reference) that the heuristic flags as a
// flush. Only session-attributed, non-first, spike rows qualify.
function heuristicFlushRows(rows) {
  const bySession = new Map();
  for (const r of rows) {
    if (r.sessionId == null) continue;
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }
  const flushed = new Set();
  for (const sessionRows of bySession.values()) {
    if (sessionRows.length < 2) continue; // only a cold start, nothing to evaluate
    sessionRows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const nonFirst = sessionRows.slice(1);
    const threshold = Math.max(
      FLUSH_ABS_FLOOR,
      FLUSH_K * median(nonFirst.map(r => r.cache_creation_tokens ?? 0)),
    );
    for (const r of nonFirst) {
      if ((r.cache_creation_tokens ?? 0) >= threshold) flushed.add(r);
    }
  }
  return flushed;
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
  // Already-applied check: no-op once every parsed row carries the flag.
  const needsBackfill = parsedRows.some(r => !('cache_flush' in r));
  if (!needsBackfill) return { applied: false };

  const flushed = heuristicFlushRows(parsedRows);

  let rowsFlagged = 0;
  for (const r of parsedRows) {
    if ('cache_flush' in r) continue; // leave decisive rows untouched
    const isFlush = flushed.has(r);
    r.cache_flush = isFlush;
    if (isFlush) rowsFlagged += 1;
  }

  const out = entries.map(e => e.obj ? JSON.stringify(e.obj) : e.raw).join('\n') + '\n';
  await writeTextAtomic(file, out);
  log(`  ✓ backfilled cache_flush on ${parsedRows.length} cost row${parsedRows.length === 1 ? '' : 's'} (${rowsFlagged} flagged) in ${file}`);
  return { applied: true, summary: { rowsTotal: parsedRows.length, rowsFlagged } };
}
