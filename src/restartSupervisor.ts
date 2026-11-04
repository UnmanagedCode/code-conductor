// The restart contract between a process supervisor and the cc server (the
// docker entrypoint runs docker/supervise.mjs). A supervised server restarts by
// releasing its projects-root lock and exiting SUPERVISED_RESTART_EXIT; the
// supervisor relaunches it in place, so the process tree above it (the
// container's init, its services, the plugin backends) never changes. Any other
// exit ends the supervisor with the same status.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import { hostPlatform } from './platform/index.ts';

// Env key the supervisor sets on the server it launches: the supervisor's pid.
export const RESTART_SUPERVISOR_ENV = 'CC_RESTART_SUPERVISOR';

// Must stay out of every code the server or a headless run exits with
// (EXIT_CODES in src/headless/result.ts, ROOT_LOCK_HELD_EXIT in src/rootLock.ts,
// 128+n for a signal): only a restart request may relaunch the server.
export const SUPERVISED_RESTART_EXIT = 75;

/**
 * Whether this server was launched by a restart supervisor. Reads
 * RESTART_SUPERVISOR_ENV once and deletes it (so no CLI, plugin or project
 * command inherits it); the server counts as supervised only when the value is
 * its parent's pid.
 */
export function takeRestartSupervisor(
  env: NodeJS.ProcessEnv = process.env, ppid: number = process.ppid, log: Pick<Console, 'warn'> = console,
): boolean {
  const value = env[RESTART_SUPERVISOR_ENV];
  if (value === undefined) return false;
  delete env[RESTART_SUPERVISOR_ENV];
  if (value === String(ppid)) return true;
  log.warn(`restart: ${RESTART_SUPERVISOR_ENV}=${value} names a pid other than this server's parent (${ppid}); restarting by self-respawn`);
  return false;
}

// SIGUSR1 is not forwarded: node reserves it for the inspector.
const FORWARDED = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const;

interface SignalSource {
  on(signal: string, handler: () => void): unknown;
}

export interface SuperviseOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  // The server gets its own process group, so a terminal's group-wide signals
  // (^C, ^\) never reach it directly: only the supervisor's forward does.
  // Known limitation: on a TTY this supervisor sits in init's foreground group,
  // so it gets ^C both directly and via init's forward, and forwards it twice
  // (a headless run treats a second signal as "end now"). The docker deployment
  // allocates no TTY, so this has no effect there.
  spawnOptions?: SpawnOptions;
  signals?: SignalSource;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

/** Run `command` and relaunch it whenever it exits SUPERVISED_RESTART_EXIT; mirror any other end. */
export function superviseServer({
  command, args, cwd = process.cwd(), env = process.env, spawn = nodeSpawn,
  spawnOptions = hostPlatform.spawnOptions('daemon'), signals = process,
  kill = (pid, signal) => process.kill(pid, signal), exit = (code) => process.exit(code),
  log = (m) => console.error(m),
}: SuperviseOptions): void {
  let current: ChildProcess | null = null;
  let stopping = false;

  const launch = () => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        ...spawnOptions, stdio: 'inherit', cwd,
        env: { ...env, [RESTART_SUPERVISOR_ENV]: String(process.pid) },
      });
    } catch (e) {
      log(`cc-supervisor: could not start ${command}: ${e instanceof Error ? e.message : String(e)}`);
      exit(1);
      return;
    }
    current = child;
    log(`cc-supervisor: started server pid=${child.pid}`);
    child.once('error', (e) => {
      log(`cc-supervisor: server pid=${child.pid} failed: ${e.message}`);
      exit(1);
    });
    child.once('exit', (code, signal) => {
      if (code === SUPERVISED_RESTART_EXIT && !stopping) {
        log(`cc-supervisor: server pid=${child.pid} exited ${code} (restart requested); relaunching`);
        launch();
        return;
      }
      log(signal
        ? `cc-supervisor: server pid=${child.pid} ended by ${signal}`
        : `cc-supervisor: server pid=${child.pid} exited ${code}`);
      exit(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1));
    });
  };

  for (const sig of FORWARDED) {
    signals.on(sig, () => {
      stopping = true;
      if (current?.pid === undefined) return;
      try { kill(current.pid, sig); } catch { /* already gone */ }
    });
  }
  launch();
}
