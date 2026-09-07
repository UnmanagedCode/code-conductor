// The immutable per-session geometry of one FUSE-union chroot: where the mount
// lives, what the daemon is told, what the bootstrap is handed, and the two
// on-disk records teardown and the boot sweep read.
//
// Everything a session needs sits in ONE directory, `fuseRunDir(instanceId)`,
// so a crashed orchestrator's residue is enumerable by name rather than by
// search — an instance id is a fresh uuid per process, so any directory left
// under `run/` at boot is dead by construction (the same argument that licenses
// sweepSessionTmpDirs).

import path from 'node:path';
import { orchStoreRoot } from '../../projects.ts';
import { withinPosix } from '../mirror.ts';
import { httpError } from '../../httpError.ts';
import { renderPinsFile, type TierEntry } from './tierTable.ts';

// Zero kernel caching. `attr_timeout`/`entry_timeout`/`negative_timeout` are
// libfuse HIGH-LEVEL mount options, so the frozen daemon passes them through
// `fuse_main` untouched and needs no source change to honour them (its
// `pt_init` sets only `use_ino` and `kernel_cache`).
//
// The epic's reason: FUSE's attribute cache is per-inode, not per-caller, so
// one path measurably answered 15 bytes to `stat` and 33 to `cat` across the
// routing boundary. `allow_other` + `default_permissions` are mandatory from
// the first mount — the daemon runs as root and serves callers of another uid.
export const MOUNT_OPTS = 'allow_other,default_permissions,attr_timeout=0,entry_timeout=0,negative_timeout=0';

export const RECORD_SCHEMA = 1;

export function fuseRunRoot(): string {
  return path.join(orchStoreRoot(), 'systems', 'fuse', 'run');
}

export function fuseRunDir(instanceId: string): string {
  return path.join(fuseRunRoot(), instanceId);
}

export function fuseBinDir(): string {
  return path.join(orchStoreRoot(), 'systems', 'fuse', 'bin');
}

// cc's pre-record, written BEFORE spawn. Its whole job is to make a crash
// between spawn and the bootstrap's handshake recoverable by name: the run
// directory exists and says whose it is, even though no mount happened yet.
export interface FuseIntent {
  schema: number;
  instanceId: string;
  ccBootId: string;
  rundir: string;
  root: string;
  mirror: string;
  fusectl: string;
  spawnedAt: number;
}

// The bootstrap's handshake, written at step 7 while the mount exists. `minor`
// is captured from /proc/self/mountinfo AT MOUNT TIME and never re-resolved:
// resolving it by mountpoint works only while the mount is there, so the same
// helper silently no-ops when called after an unmount — which is exactly when
// teardown calls it (S3 §A4 step 1).
export interface FuseMountRecord extends FuseIntent {
  // `starting` — the bootstrap has started processes but the mount is not up
  // yet; `mounted` — the handshake is complete. cc's awaitHandshake waits for
  // `mounted`; TEARDOWN acts on either, which is the whole point of writing the
  // record three times (bootstrap.sh step 2a).
  stage?: 'starting' | 'mounted';
  nsMntId: string;
  bootstrapPid: number;
  bootstrapStart: string;
  // The namespace anchor — a credential-stable process whose
  // /proc/<pid>/ns/mnt stays openable. See bootstrap.sh step 2b for why the
  // daemon's and the worker's do not.
  anchorPid: number;
  anchorStart: string;
  daemonPid: number;
  daemonStart: string;
  minor: string;
  mountedAt: number;
  // Filled in by teardown when it could not finish. The record is then KEPT so
  // the next boot sweep re-reports the wedge rather than silently rediscovering
  // it.
  wedged?: boolean;
  terminalState?: string;
  residualMounts?: string[];
  survivingPids?: string[];
  at?: number;
}

export interface FusePlan {
  instanceId: string;
  rundir: string;
  root: string;
  mirror: string;
  fusectl: string;
  pinsPath: string;
  intentPath: string;
  recordPath: string;
  daemonLog: string;
  // THE REFUSAL LOG the daemon writes (`CC_UNION_REFUSALS`) — every fail-closed
  // path, every unmarked denial, every refused control reply. It is the
  // instrument the pin list is derived from and the thing that must be empty by
  // the end; the real gate reads it (R4).
  refusalLog: string;
  // The cwd the bootstrap `cd`s to INSIDE the chroot. A host-pinned path keeps
  // its exact spelling, which is why this is simply the CLI's cwd.
  cwdInside: string;
  mountOpts: string;
  // cc's control socket, which the daemon connects to and refuses to mount
  // without. It is under `rundir` — a SIBLING of `root`, tiered `hide` — so
  // nothing inside the chroot can name it. Containment is structural here,
  // not policy.
  controlSock: string;
  // THE PATH WHOSE RESOLUTION MARKS A THREAD GROUP AS THE CLI — the launcher
  // binary, absolute, in the spelling the kernel will ask the union about. The
  // daemon refuses to mount without it: with no marking event no caller is ever
  // marked and the project tier is unreachable, which would look exactly like a
  // containment success.
  markPath: string;
  tiers: TierEntry[];
  pinsText: string;
  uid: number;
  gid: number;
  // THE SOURCE OVERRIDE'S ROOT, or '' in production. See
  // `FusePlanInput.sourceOverrideRoot`; the only thing this field does here is
  // feed the containment refusal below.
  sourceOverrideRoot: string;
  // WHERE THE DAEMON WRITES ITS PER-OP TRACE, or '' when tracing is off — and
  // off is the default, because the daemon's `tr()` resolves ids per op and
  // reads /proc, which production must not pay for. `CC_FUSE_TRACE=1` turns it
  // on (and nothing else does — see resolveTraceEnabled); it is the instrument
  // the two-handle premise and the per-op accounting are measured with.
  tracePath: string;
}

// THE DAEMON'S PER-OP TRACE, off by default. `union.c` has honoured
// `CC_UNION_TRACE` since the fork and cc has never set it; `tr()` calls
// `resolve_ids` per op and reads /proc, so it is opt-in rather than always-on.
//
// EXACTLY `'1'`, AND THE WORKER-SIDE VARIABLE HAS A DIFFERENT NAME. This is the
// operator's switch and cc is its only reader; the PATH the bootstrap hands the
// daemon is `CC_FUSE_TRACE_LOG` (wrap.ts). One name for both would put an
// operator's `CC_FUSE_TRACE=0` — the natural way to turn something OFF — into
// the worker's path slot, where a non-emptiness test reads it as on.
export function resolveTraceEnabled(): boolean {
  return process.env.CC_FUSE_TRACE === '1';
}

export interface FusePlanInput {
  instanceId: string;
  cwdInside: string;
  // WHERE THE SOURCE'S BYTES COME FROM WHEN THEY DO NOT COME FROM THE SYSTEM —
  // a local directory standing in for the remote, or null in production. It is
  // the LIFECYCLE GATE'S INSTRUMENT, not a production knob: criteria 3 and 4
  // are only checkable when the remote's bytes DIFFER from the host's at the
  // same path, and that gate must not need a container. `src/instances.ts` is
  // the one reader of the environment variable behind it.
  sourceOverrideRoot: string | null;
  markPath: string;
  // THE TIER TABLE, BUILT BY THE CALLER AND CARRIED BY REFERENCE. It is not
  // built here, and that is criterion 15's mechanism rather than a style
  // choice: `src/instances.ts` builds ONE array and hands the SAME array to
  // `SessionRedirect` and to this function, so the pins the daemon parses and
  // the table the hook decides from are the same object. A second
  // `buildTierTable` call here would produce an equal table that could later
  // stop being equal.
  //
  // It is also why the plan no longer takes `localRoots`, `claudeCommand` or a
  // `mirrorRoot`: every one of those is an input to the table, and the table's
  // one construction site owns them.
  tiers: TierEntry[];
}

export function buildFusePlan(input: FusePlanInput): FusePlan {
  const rundir = fuseRunDir(input.instanceId);
  const root = path.join(rundir, 'root');
  const mirror = path.join(rundir, 'mirror');

  // CONFIGURATION-TIME REFUSAL: THE SOURCE MUST NOT CONTAIN CC'S OWN STAGING
  // MIRROR. cc materialises a remote path P at `<mirror>/P` and reads it from
  // `<sourceOverrideRoot>/P`; where the mirror lies inside the source root,
  // some P resolves back into the mirror and cc serves its own staging area as
  // remote content — a listing of the source enumerates the mirror, and what
  // the worker then reads is cc's copy of what it already had.
  //
  // IT GUARDS THE OVERRIDE ROOT, WHICH IS WHAT IT ALWAYS GUARDED. In production
  // there is no root at all — a path P from the daemon IS the path on the
  // system — so there is no arithmetic for a containment to break, and the
  // check has nothing to do.
  //
  // Whether such a P is REACHABLE depends on the tier table, which is a
  // per-session artifact; this refuses on the containment itself, which is the
  // conservative half of that question and the half decidable here.
  //
  // ROOT `/` IS EXEMPT, and on a MEASURED mechanism rather than on intent.
  // There, `<sourceOverrideRoot>/P` is P, so cc reads the mirror only for a P at
  // or inside the mirror — and the mirror is `<runDir>/mirror` while `runDir`
  // carries a `hide` pin (tierTable.ts), which longest-prefix makes win over
  // even a `project /`. `route()` answers `-ENOENT` for a `hide` path before
  // any control frame is sent, so no such P reaches cc at all.
  //
  // The mirror's SHALLOW ancestors (`/`, and whatever contains the projects
  // root) do stay remote-tier under an advertised root of `/`. That is not the
  // hazard: a `LIST` materialises one level of directory entries and never
  // descends, and the chain from the projects root down to `runDir` is `host`,
  // so no frame ever names the mirror's parent. `tests/fuse-lifecycle.test.mjs`
  // asserts both halves against the real table.
  const override = input.sourceOverrideRoot;
  const inside = override === null || override === '/' ? null : withinPosix(mirror, override);
  if (inside !== null) {
    throw httpError(501, `FUSE_REMOTE_ROOT_CONTAINS_MIRROR: this session's staging mirror ${mirror} lies inside the remote root ${override} (at '${inside}'), so cc would read its own mirror back as remote content and serve it to the worker`, { code: 'FUSE_REMOTE_ROOT_CONTAINS_MIRROR' });
  }

  return {
    instanceId: input.instanceId,
    rundir,
    root,
    mirror,
    fusectl: path.join(rundir, 'fusectl'),
    pinsPath: path.join(rundir, 'pins.txt'),
    intentPath: path.join(rundir, 'intent.json'),
    recordPath: path.join(rundir, 'mount.json'),
    daemonLog: path.join(rundir, 'daemon.log'),
    refusalLog: path.join(rundir, 'refusals.log'),
    controlSock: path.join(rundir, 'control.sock'),
    markPath: input.markPath,
    cwdInside: input.cwdInside,
    mountOpts: MOUNT_OPTS,
    tiers: input.tiers,
    pinsText: renderPinsFile(input.tiers),
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    sourceOverrideRoot: override ?? '',
    tracePath: resolveTraceEnabled() ? path.join(rundir, 'trace.log') : '',
  };
}

