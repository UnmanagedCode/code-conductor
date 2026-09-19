// The pending-temp-cleanup manifest used to persist `{ cwd, sessionId }`. A
// bare cwd no longer names a transcript directory: a remote-backed worker runs
// at the remote's own path spelling, so `/root/app3` is one cwd on every box
// that has it, and the sweep's `subAgentDirPath` needs the machine coordinate
// too. The manifest now persists `{ place, sessionId }`.
//
// AN ENTRY WRITTEN BEFORE THAT HAS NO PLACEMENT AND NONE CAN BE INVENTED. The
// safe reading is that its directory is unknown, so this clears the coordinate
// outright. The sweep's existing place-less branch then degrades to bookkeeping
// only — `unmarkTemp` + `markArchived`, no directory removal — which is exactly
// the behaviour crash-orphaned temps have always had.
//
// NOTHING IS DESTROYED. The transcript jsonl is never touched by the sweep
// (temp sessions are archived, not deleted), so the entire loss is at most one
// orphaned subagent directory per temp session that happened to be in flight
// across the upgrade. Guessing a placement instead would risk deleting the
// subagent directory of a DIFFERENT remote's session at the same path, which is
// the worse failure by a wide margin.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const name = '0036-temp-cleanup-manifest-place';

const STORE = '.code-conductor';
const MANIFEST = 'pending-temp-cleanup.json';

// A placement as the current writer spells it. Duplicated rather than imported,
// like every other migration's copy of a shape: a migration must stay faithful
// to the world it was written for, even after the source drifts.
function hasPlace(entry) {
  const p = entry?.place;
  return typeof p === 'object' && p !== null
    && typeof p.system === 'string' && p.system !== ''
    && typeof p.cwd === 'string' && p.cwd !== ''
    && (p.remoteId === null || typeof p.remoteId === 'string');
}

export async function run({ root, log = console.log } = {}) {
  const file = path.join(root, STORE, MANIFEST);
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e?.code === 'ENOENT') return { applied: false }; throw e; }

  let parsed;
  // A torn manifest is the sweep's own problem — it already parses
  // defensively and removes what it cannot read. Not this migration's to fix.
  try { parsed = JSON.parse(raw); } catch { return { applied: false }; }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : null;
  if (!entries) return { applied: false };

  // ALREADY APPLIED when every entry either carries a placement or has already
  // been cleared — the self-check that makes a re-run a no-op.
  const stale = entries.filter(e => typeof e === 'object' && e !== null
    && !hasPlace(e) && e.cwd !== undefined);
  if (stale.length === 0) return { applied: false };

  const next = entries.map((e) => {
    if (typeof e !== 'object' || e === null) return e;
    if (hasPlace(e)) { const { cwd: _drop, ...rest } = e; return rest; }
    const { cwd: _dropped, place: _alsoDropped, ...rest } = e;
    return { ...rest, place: null };
  });

  await fs.writeFile(file, JSON.stringify({ ...parsed, entries: next }));
  log(`migration ${name}: cleared the placement of ${stale.length} pending-temp-cleanup `
    + 'entry(ies) written before the manifest carried one — each is archived and unmarked on the '
    + 'next boot, but its subagent directory is left behind because the directory cannot be identified.');
  return { applied: true, summary: { cleared: stale.length } };
}
