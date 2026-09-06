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
import os from 'node:os';
import { statSync } from 'node:fs';
import { orchStoreRoot, projectsRoot, selfProjectDir } from '../../projects.ts';
import { withinPosix } from '../mirror.ts';
import { httpError } from '../../httpError.ts';
import { buildTierTable, renderPinsFile, type TierEntry, type TierTableInput } from './tierTable.ts';

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
  // The cwd the bootstrap `cd`s to INSIDE the chroot. A host-pinned path keeps
  // its exact spelling, which is why this is simply the CLI's cwd.
  cwdInside: string;
  mountOpts: string;
  tiers: TierEntry[];
  pinsText: string;
  uid: number;
  gid: number;
  // S1 STAND-IN — see resolveMirrorStandIn. `standInSource` is the host
  // directory bound in; `standInAt` is where under `mirror` it is bound, which
  // is the project's own remote-space path because the daemon's remote tier is
  // rooted at `mirror` and resolves `/x` to `<mirror>/x`.
  //
  // That placement is also what keeps the fake remote's tree DELIBERATELY
  // NARROW: only the project's path is populated, so every other path misses
  // the remote-first `default:` arm instead of shadowing a host one. The hazard
  // is measured, not hypothetical — S3 §B2 caught a `create` at `tier=default`
  // landing on the remote and absent from the host, because union.c:944 routes
  // a create to the remote whenever the parent exists there.
  standInSource: string | null;
  standInAt: string | null;
}

// ── the S1 STAND-IN, labelled ───────────────────────────────────────────────
//
// S1 has NO transport and NO control channel. The daemon's remote tier is a
// plain local directory, and in S1 that directory is filled by a bind mount of
// the project's own path when — and only when — that path happens to exist on
// the orchestrator's own filesystem, which is the case for every provider that
// backs a project with a directory on this host.
//
// What that proves: the per-session mirror directory's PLACEMENT, its `hide`
// tiering, and its CLEANUP, with the union's `project` tier serving real bytes.
// What it does NOT prove: any transport, any latency, any control channel. S3
// replaces this bind with cc materialising files into the same directory.
//
// It is therefore not a claim about the remote at all: where the system is
// genuinely elsewhere this returns null and the mirror stays empty.
export function resolveMirrorStandIn(systemPath: string): string | null {
  try { return statSync(systemPath).isDirectory() ? systemPath : null; }
  catch { return null; }
}

export interface FusePlanInput {
  instanceId: string;
  cwdInside: string;
  systemPath: string;
  standInSource: string | null;
  localRoots: readonly string[];
  claudeCommand: string;
  tierOverrides?: Partial<TierTableInput>;
}

export function buildFusePlan(input: FusePlanInput): FusePlan {
  const rundir = fuseRunDir(input.instanceId);
  const root = path.join(rundir, 'root');
  const mirror = path.join(rundir, 'mirror');

  // CONFIGURATION-TIME REFUSAL, and it has to be here because it cannot be
  // caught anywhere later: a remote root that CONTAINS the mount deadlocks in
  // VFS path resolution BEFORE the daemon is consulted, so no daemon-side guard
  // can see it (S2 §11.2, S3 §A3 W-D1). A kill path makes that deadlock
  // recoverable; it does not make it acceptable.
  //
  // `root` and `mirror` are siblings under `rundir` by construction, so the
  // containment cannot arise from the layout. It arises from what the S1 bind
  // puts BEHIND `mirror`: the mountpoint lives under the store, so a project
  // whose system path is an ancestor of the store makes the union's own
  // mountpoint reachable by walking its remote tier.
  const inside = input.standInSource === null ? null : withinPosix(root, input.standInSource);
  if (inside !== null) {
    throw httpError(501, `FUSE_MIRROR_CONTAINS_MOUNT: the union mountpoint ${root} lies inside its own remote tier ${input.standInSource} (at '${inside}'), which deadlocks path resolution before the daemon is consulted`, { code: 'FUSE_MIRROR_CONTAINS_MOUNT' });
  }

  const tiers = buildTierTable({
    localRoots: input.localRoots,
    claudeCommand: input.claudeCommand,
    execPath: process.execPath,
    selfProjectDir: selfProjectDir(),
    projectsRoot: projectsRoot(),
    homeDir: os.homedir(),
    runDir: rundir,
    systemPath: input.systemPath,
    ...input.tierOverrides,
  });

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
    cwdInside: input.cwdInside,
    mountOpts: MOUNT_OPTS,
    tiers,
    pinsText: renderPinsFile(tiers),
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    standInSource: input.standInSource,
    standInAt: input.standInSource === null ? null : path.join(mirror, input.systemPath),
  };
}

// ── the S1 ENGAGEMENT SWITCH ────────────────────────────────────────────────
//
// Off by default, and that is not a config knob for the finished feature — it
// is the boundary of this stage. Two facts force it:
//
//   * The chroot and the session-root geometry are BOTH live in S1 (the
//     geometry retires in Phase B). Engaging the wrap for every remote session
//     would change what every existing remote test is testing, which is exactly
//     what a gate phase must not do.
//   * FUSE, `sudo -n` and `/dev/fuse` are host facts. Termux is an explicit
//     target of this repo and has none of them, so an unconditional engagement
//     would turn "remote workers work" into "remote workers work on some
//     hosts" — a regression, not a gate.
//
// It goes away when the geometry does: once there is no session root, FUSE is
// the only mode and a host that cannot mount refuses the spawn (epic
// criterion 9), which is `assertFuseAvailable` with no switch in front of it.
export function fuseWorkersEnabled(): boolean {
  return process.env.CC_FUSE_WORKERS === '1';
}
