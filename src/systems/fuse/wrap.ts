// The argv/env/cwd transform, and nothing else. A PURE function — it returns
// the spec AND the bytes of the two environment files, and writes neither — so
// the shape of the launch is unit-testable with no sudo, no mount and no FUSE.
//
// NOTHING RIDES THROUGH SUDO. `sudo -E`, and equally a `VAR=value` argv prefix,
// needs the sudoers `SETENV:` tag; requiring that tag of every host running cc
// is the cost this module's file channel exists to avoid. So the environment cc
// means the bootstrap and the CLI to have travels in two 0600 files under the
// run directory, and the only thing handed to sudo is the `PATH` node's
// `spawn` needs to resolve the bare `sudo` — `env_reset`, sudo's default and
// now the only configuration cc requires, discards the rest anyway.
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

// One environment file's whole content, for the caller that owns the run
// directory to write. `mode` is the caller's business and 0600 is the contract
// bootstrap.sh checks; see `FuseSession.wrap`.
export interface EnvFile { path: string; content: string }

export interface WrappedLaunch { spec: LaunchSpec; files: EnvFile[] }

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

// EVERY NAME THE PLAN FILE MAY CARRY, AND THE FILTER THE WORKER FILE IS BUILT
// WITH. The two files are sourced at opposite ends of bootstrap.sh, so the
// worker's set — cc's own process environment — is sourced LAST and would win
// every collision. Stripping these names from it is what keeps the plan
// authoritative, and that is not cosmetic: `procScan.ts` and `sweep.ts`
// attribute a process by reading `CC_FUSE_INSTANCE_ID` and `CC_FUSE_RUNDIR` out of
// `/proc/<pid>/environ`, so an inherited stale value overwriting the plan's
// would blind the orphan backstop and the boot sweep while every mount test
// stayed green.
//
// `CC_FUSE_TRACE` is deliberately NOT here: it is cc's own operator switch,
// read only in cc's process (`resolveTraceEnabled`), and it rides through to
// the worker inert like any other inherited variable.
export const PLAN_KEYS = [
  'CC_FUSE_INSTANCE_ID',
  'CC_FUSE_BOOT_ID',
  'CC_FUSE_SPAWNED_AT',
  'CC_FUSE_RUNDIR',
  'CC_FUSE_ROOT',
  'CC_FUSE_MIRROR',
  'CC_FUSE_FUSECTL',
  'CC_FUSE_PINS',
  'CC_FUSE_BIN',
  'CC_FUSE_RECORD',
  'CC_FUSE_DAEMON_LOG',
  'CC_FUSE_MOUNT_OPTS',
  'CC_FUSE_CWD',
  'CC_FUSE_UID',
  'CC_FUSE_GID',
  'CC_FUSE_CONTROL',
  'CC_FUSE_MARK_PATH',
  'CC_FUSE_EVENT_LOG',
  'CC_FUSE_TRACE_LOG',
  'CC_FUSE_WORKER_ENV',
] as const;

export type PlanKey = (typeof PLAN_KEYS)[number];

const PLAN_KEY_SET: ReadonlySet<string> = new Set<string>(PLAN_KEYS);

// A portable shell identifier, which is the whole of what an `export NAME=`
// line can name.
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// SINGLE-QUOTE WRAPPING, WHICH ROUND-TRIPS EVERY BYTE. Inside single quotes the
// shell interprets nothing at all, so a newline, a `$`, a backtick, a backslash
// or a `!` survives; the one byte that cannot appear is the quote itself, which
// closes the string, escapes, and reopens.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// The bytes of one environment file: one `export` line per variable and nothing
// else, in sorted key order so the artifact left in the run directory diffs.
//
// A NAME THAT IS NOT A SHELL IDENTIFIER IS SKIPPED, NOT REFUSED. `process.env`
// carries names like `BASH_FUNC_x%%` that `dash` cannot represent at all, so
// refusing the spawn over one would break a launch that works today. The skip
// is VISIBLE — the file names what it dropped — because a silently missing
// variable is the shape that costs a reader an afternoon.
export function renderEnvFile(vars: NodeJS.ProcessEnv): string {
  // `undefined` is legal in NodeJS.ProcessEnv and `spawn` omits it; so does this.
  const names = Object.keys(vars).filter(n => vars[n] !== undefined).sort();
  const skipped = names.filter(n => !SHELL_IDENTIFIER.test(n));
  const lines: string[] = [];
  // JSON-quoted, so a name carrying a newline cannot end the comment and become
  // a command this file then runs as root.
  if (skipped.length) lines.push(`# skipped (not a shell identifier): ${skipped.map(n => JSON.stringify(n)).join(', ')}`);
  for (const n of names) {
    if (!SHELL_IDENTIFIER.test(n)) continue;
    lines.push(`export ${n}=${shellQuote(vars[n] as string)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function wrapLaunch(spec: LaunchSpec, ctx: WrapContext): WrappedLaunch {
  const { plan } = ctx;
  const planVars: Partial<Record<PlanKey, string>> = {
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
    CC_FUSE_EVENT_LOG: plan.eventLog,
    // THE PATH OF THE SECOND FILE, CARRIED IN THE FIRST. Only the plan file's
    // path rides in argv; bootstrap.sh reads this one out of it, checks it at
    // step 0 and sources it at step 10.
    CC_FUSE_WORKER_ENV: plan.workerEnvPath,
    // THE TRACE PATH, AND ITS NAME IS NOT THE OPERATOR'S SWITCH.
    //
    // `CC_FUSE_TRACE` is cc's own on/off flag, read by `resolveTraceEnabled`
    // and keyed exactly on `'1'`; this is the worker-side PATH the bootstrap
    // hands the daemon, and the bootstrap tests it for NON-EMPTINESS. Two
    // meanings under one name would put an orchestrator's own `CC_FUSE_TRACE=0`
    // — the most natural way an operator turns something off — into this slot,
    // where that test reads it as ON and the daemon gets `CC_UNION_TRACE="0"`:
    // `fopen("0","a")` as root writes a junk file named `0` and pays the full
    // per-op tracing cost on every spawn. Keeping the two names apart is what
    // puts that out of reach, and `instances.ts` builds the worker env as
    // `{...process.env}`, so the operator's value IS in `spec.env` at every
    // launch.
    //
    // THE CONTRACT: when cc chose no tracing, the plan file does not NAME this
    // key. Set below rather than here so that stays true — an
    // `export CC_FUSE_TRACE_LOG=''` is inert under the bootstrap's test, but it
    // is a value where the plan means an absence. An INHERITED one cannot
    // arrive by the other door either: this name is in PLAN_KEYS, so the worker
    // file — sourced last, and otherwise the winner — is stripped of it.
  };
  if (plan.tracePath) planVars.CC_FUSE_TRACE_LOG = plan.tracePath;
  // cc's own environment, MINUS every name the plan owns — see PLAN_KEYS.
  //
  // DISCLOSED RESIDUAL: EVERY OTHER NAME IS DELIVERED VERBATIM, `LD_PRELOAD`
  // and `LD_LIBRARY_PATH` included, where sudo's own environment policy strips
  // that class from what it forwards. Not a boundary crossing — cc writes the
  // file, the CLI cc is launching reads it, both on the far side of the
  // privilege drop, and an unwrapped launch hands the CLI cc's environment
  // wholesale anyway. It IS a difference from what the root-side bootstrap and
  // the daemon see, which get sudo's filtered set plus the plan file.
  const workerVars: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(spec.env)) {
    if (!PLAN_KEY_SET.has(k)) workerVars[k] = v;
  }
  return {
    spec: {
      command: 'sudo',
      args: [
        '-n',
        'unshare', '--mount', '--propagation', 'private', '--',
        ctx.bootstrap ?? BOOTSTRAP,
        // THE PLAN FILE AND CC'S UID, a FIXED-ARITY positional prefix the
        // bootstrap consumes with `shift 2`. Fixed arity is what makes a `--`
        // separator unnecessary, so the CLI's argv stays safe for an argument
        // spelled like an option.
        //
        // NEITHER WORD IS A SECRET. /proc/<pid>/cmdline is world-readable; the
        // 0600 file this names is not.
        plan.planEnvPath, String(plan.uid),
        // The CLI's own argv, passed POSITIONALLY and consumed as `"$@"`. Safe
        // for an argument containing a newline or a space: this is an execve argv
        // array from end to end and `"$@"` never re-splits it. (What an argument
        // containing a newline DOES break is a TRACE parsing
        // /proc/<pid>/cmdline, which is a reader's problem, not this argv's.)
        spec.command, ...spec.args,
      ],
      // The CLI's real cwd is `CC_FUSE_CWD`, which the bootstrap `cd`s to INSIDE
      // the chroot. On the host it may not exist at all, and spawn() would fail
      // with ENOENT before the bootstrap ever ran.
      cwd: '/',
      // WHAT SUDO ITSELF IS HANDED, AND IT IS ONLY WHAT SPAWN NEEDS: `PATH`, to
      // resolve the bare `sudo`. Everything else would be discarded by
      // `env_reset` anyway, and keeping cc's environment out of
      // /proc/<sudopid>/environ is also what lets bootstrap.sh compose the
      // daemon's environment rather than defend it. DISCLOSED RESIDUAL: a host
      // that needs some other variable to dynamically link `sudo` itself would
      // have to add that one name here. What the CLI gets is the other
      // residual, at `workerVars` above.
      env: { PATH: spec.env.PATH ?? '' },
    },
    files: [
      { path: plan.planEnvPath, content: renderEnvFile(planVars) },
      { path: plan.workerEnvPath, content: renderEnvFile(workerVars) },
    ],
  };
}
