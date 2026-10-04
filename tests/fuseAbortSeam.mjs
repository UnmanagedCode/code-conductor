// THE SHIPPING ABORT PATH, RUN AGAINST FILES. `createRealMountDriver({ exec })`
// builds the same driver `realMountDriver` is; `localExec` is an `exec` that
// strips only the privilege prefix (`sudo -n nsenter --mount=/proc/<pid>/ns/mnt
// --`), swaps the namespace's `/proc/self/mountinfo` for a rendered file, and
// runs the rest — the shipping script with the shipping positionals — as this
// uid. So the ownership decision is the real one, not a re-implementation.
//
// Not named `*.test.mjs`, so run.mjs's discover() ignores it.

import assert from 'node:assert/strict';
import { runStatus } from '../src/systems/fuse/driver.ts';

const NS_MOUNT = /^--mount=\/proc\/(\d+)\/ns\/mnt$/;
export const NS_MOUNTINFO = '/proc/self/mountinfo';

// `mountinfoFor(nsPid)` returns the path of a file to read in place of the
// namespace's mountinfo; `after({ nsPid, status })` runs once the command has.
export function localExec({ mountinfoFor, after = () => {} }) {
  return async (cmd, args, timeoutMs) => {
    assert.equal(cmd, 'sudo');
    assert.deepEqual(args.slice(0, 2), ['-n', 'nsenter']);
    const m = NS_MOUNT.exec(args[2]);
    assert.ok(m, `not an nsenter into a pid's mount namespace: ${args[2]}`);
    assert.equal(args[3], '--');
    const argv = args.slice(4);
    assert.equal(argv.at(-1), NS_MOUNTINFO, 'the check does not read the namespace\'s own mountinfo');
    const nsPid = Number(m[1]);
    const status = await runStatus(argv[0], [...argv.slice(1, -1), await mountinfoFor(nsPid)], timeoutMs);
    await after({ nsPid, status });
    return status;
  };
}

// /proc/<pid>/mountinfo escapes space, tab, newline and backslash as octal.
const esc = (p) => p.replace(/[ \t\n\\]/g, (c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'));

// One mountinfo line per mountpoint; a mountpoint in `devs` carries that FUSE
// minor, every other one a dev no recorded minor can equal.
export function renderMountinfo(mounts, devs = {}) {
  return mounts.map((mp, i) => `${100 + i} 1 ${devs[mp] !== undefined ? `0:${devs[mp]}` : '8:0'} / ${esc(mp)} rw - fuse.x x rw`)
    .join('\n') + '\n';
}
