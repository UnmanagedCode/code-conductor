// Migration entrypoint. Called once on server boot from server.js
// before listen(); each registered migration runs in order and is
// responsible for its own "already applied?" idempotency check. A
// thrown error aborts boot — better than limping along with half-
// migrated state.

import * as m0001 from './0001-centralize-orchestrator-state.mjs';
import * as m0002 from './0002-rename-group-to-workspace.mjs';
// 0003-conduct-md-symlink is intentionally NOT registered: it created a
// .conduct/CONDUCT.md symlink. That path later became a fully-owned generated
// file (0010) and is now removed entirely (0022) — the conductor role prompt
// is injected at spawn via --append-system-prompt, no on-disk file. Leaving
// 0003 in the chain would make it recreate the symlink / warn every boot.
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
import * as m0014 from './0014-backfill-cache-miss-flags.mjs';
import * as m0015 from './0015-enable-context-renewal-module.mjs';
import * as m0016 from './0016-migrate-family-settings-to-tiers.mjs';
// 0017-collapse-tier-backend-to-kind-model is intentionally NOT registered:
// SUPERSEDED BY 0018b. Its "already applied?" probe was "does some
// models.tierBackend value carry a `kind` key?", and 0018b renames that key to
// `backend` — so leaving 0017 in the chain would make it re-run on every boot
// after the 0018b upgrade and reset every tier binding to its Claude default.
// 0018b absorbs the pre-0017 shapes it used to normalize (see its header).
//
// 0019-inline-sonnet-window-into-bindings stays registered but is now permanently
// inert: 0018b runs first and consumes `models.sonnetContextWindow` (for BOTH the
// pre-0017 string form and the post-0017 {kind,model} form), so 0019's probe
// `'sonnetContextWindow' in models` is false on every store from here on. It is
// kept in the chain as the historical record, and because a store that already ran
// it must keep reading as already-applied.
import * as m0018 from './0018-session-backends-carry-model.mjs';
// Letter-suffixed so numeric order still equals EXECUTION order: it must run
// after 0018 (it assumes the map-shaped sidecar 0018 produces) and BEFORE 0019,
// which would otherwise delete `models.sonnetContextWindow` without having
// backfilled it — on a pre-0017 store the bindings are still family-key STRINGS,
// so 0019's guard can't match them and a user's explicit 200k Sonnet pin would be
// destroyed before 0018b could materialize it. 0018b consumes that global itself.
import * as m0018b from './0018b-backend-registry.mjs';
import * as m0019 from './0019-inline-sonnet-window-into-bindings.mjs';
import * as m0020 from './0020-consolidate-convention-stores.mjs';
import * as m0021 from './0021-strip-plugin-slugs-from-conductor-conventions.mjs';
import * as m0022 from './0022-drop-conduct-md-file.mjs';
import * as m0023 from './0023-clamp-compact-window-floor.mjs';
import * as m0024 from './0024-drop-managed-backend-env-overrides.mjs';
import * as m0025 from './0025-seed-explicit-tier-role-effort.mjs';
import * as m0026 from './0026-drop-sonnet-window-state.mjs';

// Ordered list. Numeric (lexicographic) order IS execution order — keep it that
// way: append to the end, or letter-suffix (`0018b`) when a migration must slot
// between two shipped ones. Order matters: later migrations may assume earlier
// ones have run, and an earlier one can destroy state a later one needs.
// Exported so a test can replay a PREFIX of the real chain in its registered
// order. Some ordering invariants are only observable mid-chain — e.g. 0018b
// must consume `models.sonnetContextWindow` before 0019 deletes it, but 0026
// later drops the `window` key that proves it did, so asserting on the
// end state alone would pass even with the two reordered.
export const ALL = [m0001, m0002, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015, m0016, m0018, m0018b, m0019, m0020, m0021, m0022, m0023, m0024, m0025, m0026];

export async function runMigrations({ root, log = console.log } = {}) {
  for (const m of ALL) {
    const result = await m.run({ root, log });
    if (result?.applied) {
      const tail = result.summary ? ' — ' + JSON.stringify(result.summary) : '';
      log(`migration ${m.name}: applied${tail}`);
    }
  }
}
