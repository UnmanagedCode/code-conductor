// Migration entrypoint. Called once on server boot from server.js
// before listen(); each registered migration runs in order and is
// responsible for its own "already applied?" idempotency check. A
// thrown error aborts boot — better than limping along with half-
// migrated state.

import * as m0001 from './0001-centralize-orchestrator-state.mjs';
import * as m0002 from './0002-rename-group-to-workspace.mjs';
import * as m0003 from './0003-conduct-md-symlink.mjs';
import * as m0004 from './0004-relocate-av-installs.mjs';
import * as m0005 from './0005-rename-conducted-marker.mjs';
import * as m0006 from './0006-init-cost-tracking.mjs';

// Ordered list — append new migrations to the end. Order matters:
// later migrations may assume earlier ones have run.
const ALL = [m0001, m0002, m0003, m0004, m0005, m0006];

export async function runMigrations({ root, log = console.log } = {}) {
  for (const m of ALL) {
    const result = await m.run({ root, log });
    if (result?.applied) {
      const tail = result.summary ? ' — ' + JSON.stringify(result.summary) : '';
      log(`migration ${m.name}: applied${tail}`);
    }
  }
}
