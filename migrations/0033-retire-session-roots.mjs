// The FUSE-union geometry retires the per-session local session root: a remote
// worker's CLI now runs at the project's real path on its system, and nothing
// composes `<store>/systems/<id>/sessions/**` any more.
//
// That leaves an orphaned tree on every install that ever spawned a remote
// worker, and it is NOT safe to delete. A session root was the CLI's working
// directory: a worker could write into it, and a push that failed left the local
// copy holding content the system does not have — `fileBridge`'s sticky
// divergence. Those bytes exist nowhere else. So this MOVES THE TREE ASIDE and
// says where it went, rather than reclaiming the space.
//
// Idempotent by construction: it acts only when the live `sessions` directory
// exists, and the destination carries a timestamp so a second run cannot
// collide with the first. The manifests (`<key>.manifest.json`) sit BESIDE the
// roots inside `sessions/`, so moving the directory takes them with it.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const name = '0033-retire-session-roots';

const STORE = '.code-conductor';
const RETIRED = 'retired-session-roots';

export async function run({ root, log = console.log }) {
  const systemsDir = path.join(root, STORE, 'systems');
  let systems;
  try {
    systems = (await fs.readdir(systemsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return { applied: false };   // no systems have ever been registered
  }

  const moved = [];
  for (const id of systems) {
    const from = path.join(systemsDir, id, 'sessions');
    try { if (!(await fs.stat(from)).isDirectory()) continue; } catch { continue; }

    // Timestamped, so a re-run after a partial move cannot land on top of an
    // earlier one, and an operator can tell the two apart.
    const to = path.join(systemsDir, id, `${RETIRED}-${Date.now()}`);
    try {
      await fs.rename(from, to);
      moved.push({ system: id, to });
    } catch (e) {
      // A tree cc cannot move must not abort the boot: it is orphaned either
      // way, and refusing to start over it helps nobody. Named, and left.
      log(`migration ${name}: could not move ${from} aside: ${e.message}`);
    }
  }

  if (moved.length === 0) return { applied: false };
  log(`migration ${name}: a remote worker now runs at the project's own path on its system, `
    + `so cc no longer keeps a local session root. The old roots were MOVED ASIDE, not deleted — `
    + `a failed write-back could have left edits in one that exist nowhere else. `
    + `Review and remove: ${moved.map(m => m.to).join(', ')}`);
  return { applied: true, summary: { moved: moved.length, systems: moved.map(m => m.system) } };
}
