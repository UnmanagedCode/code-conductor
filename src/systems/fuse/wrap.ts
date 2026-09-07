// The argv/env/cwd transform, and nothing else. A PURE function, so the shape
// of the launch — that it goes through `sudo -n unshare --mount --propagation
// private`, that the cwd is rewritten, that spawnEnv rides through — is
// unit-testable with no sudo, no mount and no FUSE.
//
// EVERY STEP OF THE CHAIN MUST `exec`. cc's spawn() builds readline over
// proc.stdout/stderr and _sendRaw needs proc.stdin.writable, so the fds have to
// pass straight through; and the final pid must be the CLI's, which is what
// makes `bootstrapPid` in the mount record the pid teardown signals.
//
// `sudo` itself is the ONE link that does not exec through — it forks and
// waits, and cannot forward SIGKILL — which is exactly why cc records the inner
// pid from the bootstrap rather than signalling `proc.pid`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FusePlan } from './plan.ts';

export const BOOTSTRAP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type LaunchWrap = (spec: LaunchSpec) => LaunchSpec;

export interface WrapContext {
  plan: FusePlan;
  unionBinary: string;
  // Carried into the mount record the bootstrap writes, so a record found by
  // the boot sweep names the process that created it and the boot it belonged
  // to (an id from THIS boot means a live session, not residue).
  ccBootId: string;
  spawnedAt: number;
  bootstrap?: string;
}

export function wrapLaunch(spec: LaunchSpec, ctx: WrapContext): LaunchSpec {
  const { plan } = ctx;
  const env: NodeJS.ProcessEnv = {
    ...spec.env,
    CC_FUSE_INSTANCE_ID: plan.instanceId,
    CC_FUSE_BOOT_ID: ctx.ccBootId,
    CC_FUSE_SPAWNED_AT: String(ctx.spawnedAt),
    CC_FUSE_RUNDIR: plan.rundir,
    CC_FUSE_ROOT: plan.root,
    CC_FUSE_MIRROR: plan.mirror,
    CC_FUSE_FUSECTL: plan.fusectl,
    CC_FUSE_PINS: plan.pinsPath,
    CC_FUSE_BIN: ctx.unionBinary,
    CC_FUSE_RECORD: plan.recordPath,
    CC_FUSE_DAEMON_LOG: plan.daemonLog,
    CC_FUSE_MOUNT_OPTS: plan.mountOpts,
    CC_FUSE_CWD: plan.cwdInside,
    CC_FUSE_UID: String(plan.uid),
    CC_FUSE_GID: String(plan.gid),
    CC_FUSE_CONTROL: plan.controlSock,
    CC_FUSE_MARK_PATH: plan.markPath,
    CC_FUSE_REFUSAL_LOG: plan.refusalLog,
    // OMITTED ENTIRELY when tracing is off, rather than sent empty: the
    // bootstrap forwards it to `CC_UNION_TRACE` unconditionally, and an unset
    // variable expands empty there, so the off path is byte-identical to
    // before this existed.
    ...(plan.tracePath ? { CC_FUSE_TRACE: plan.tracePath } : {}),
    // sudo's `secure_path` replaces PATH even under `-E`, so the PATH the CLI
    // is meant to run with is carried in a name sudo does not know about and
    // restored by the bootstrap immediately before the final exec. Without this
    // a non-absolute `claude` (resolveClaudeBin's default) is looked up against
    // sudoers' PATH rather than cc's.
    CC_FUSE_PATH: spec.env.PATH ?? '',
  };
  return {
    command: 'sudo',
    args: [
      '-n', '-E',
      'unshare', '--mount', '--propagation', 'private', '--',
      ctx.bootstrap ?? BOOTSTRAP,
      // The CLI's own argv, passed POSITIONALLY and consumed as `"$@"`. Safe
      // for an argument containing a newline or a space: this is an execve argv
      // array from end to end and `"$@"` never re-splits it. (The S3 defect
      // that argued for env-passing was a TRACE parsing /proc/<pid>/cmdline,
      // not an argument being split in flight.)
      spec.command, ...spec.args,
    ],
    // The CLI's real cwd is `CC_FUSE_CWD`, which the bootstrap `cd`s to INSIDE
    // the chroot. On the host it may not exist at all, and spawn() would fail
    // with ENOENT before the bootstrap ever ran.
    cwd: '/',
    env,
  };
}
