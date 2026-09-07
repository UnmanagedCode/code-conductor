// The boot sweep, run in a FRESH PROCESS. That is the whole point of the
// fixture: the restart arm has to prove the sweep works from the on-disk record
// alone, with nothing left in the orchestrator's memory to help it — which is
// exactly the situation after `scheduleRestart` calls `process.exit(0)`.
//
// argv[2] is the run root; PROJECTS_ROOT is derived back from it so the sweep's
// own `fuseRunRoot()` resolves to the same place.
//
// Prints one JSON line: the array of teardown reports, so the caller can assert
// on what the sweep said rather than on what it can observe afterwards.

import path from 'node:path';
import { sweepFuseSessions } from '../../src/systems/fuse/sweep.ts';

const runRoot = process.argv[2];
if (!runRoot) { console.error('usage: fuseSweepProbe.mjs <run root>'); process.exit(2); }
// <projectsRoot>/.code-conductor/systems/fuse/run → up four.
process.env.PROJECTS_ROOT = path.resolve(runRoot, '..', '..', '..', '..');

const warnings = [];
const reports = await sweepFuseSessions({ log: { warn: (...a) => warnings.push(a.join(' ')) } });
for (const w of warnings) console.error(w);
console.log(JSON.stringify(reports));
