// Migration entrypoint. Called once on server boot from server.js
// before listen(); each registered migration runs in order and is
// responsible for its own "already applied?" idempotency check. A
// thrown error aborts boot — better than limping along with half-
// migrated state.

import * as m0001 from './0001-centralize-orchestrator-state.mjs';
import * as m0002 from './0002-rename-group-to-workspace.mjs';
// 0003-conduct-md-symlink is intentionally NOT registered: it created a
// .conduct/CONDUCT.md symlink, but that file is now a fully-owned generated
// file (see 0010 + src/conduct.js). Leaving 0003 in the chain would make it
// recreate the symlink / warn every boot. 0010 takes over its still-useful
// jobs (drop the legacy symlink, repair a broken external @-import).
import * as m0004 from './0004-relocate-av-installs.mjs';
import * as m0005 from './0005-rename-conducted-marker.mjs';
import * as m0006 from './0006-init-cost-tracking.mjs';
import * as m0007 from './0007-migrate-legacy-model-settings.mjs';
import * as m0008 from './0008-migrate-tiered-session-summaries.mjs';
import * as m0009 from './0009-seed-legacy-shell-installer-baseline.mjs';
import * as m0010 from './0010-conduct-md-generated-file.mjs';
import * as m0011 from './0011-rename-optional-guidelines-store.mjs';
import * as m0012 from './0012-drop-retired-execution-modes-slug.mjs';
import * as m0013 from './0013-drop-retired-talking-to-user-slug.mjs';
import * as m0014 from './0014-backfill-cache-flush-flags.mjs';

// Ordered list — append new migrations to the end. Order matters:
// later migrations may assume earlier ones have run.
const ALL = [m0001, m0002, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014];

export async function runMigrations({ root, log = console.log } = {}) {
  for (const m of ALL) {
    const result = await m.run({ root, log });
    if (result?.applied) {
      const tail = result.summary ? ' — ' + JSON.stringify(result.summary) : '';
      log(`migration ${m.name}: applied${tail}`);
    }
  }
}
