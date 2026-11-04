// Host-OS differences in spawning, shells, killing, command-line splitting and
// path identity. One implementation per OS (`posix.ts`), selected once in
// `index.ts`; call sites take the platform by injection and never branch on the
// OS themselves.

import type { ExecSpec } from '../systems/system.ts';

// How a spawned child relates to cc: `child` is tied to cc's lifetime, `group`
// leads its own process group (one-shot commands that fork grandchildren),
// `daemon` must outlive cc (plugin backends, the restart replacement).
export type SpawnRole = 'child' | 'group' | 'daemon';
export type KillSignal = 'SIGTERM' | 'SIGKILL';
export interface ChildHandle { pid?: number | null; kill(signal?: NodeJS.Signals): unknown }

// Where a projects-root lock holder listens (src/rootLock.ts), as its record
// stores it: `store` is a socket file in the lock dir, named relative to it so
// a reader that mounts the store at another path still finds it; `tmp` an
// absolute socket path; `pipe` a Windows named pipe.
export type RootLockSock =
  | { kind: 'store'; name: string }
  | { kind: 'tmp'; path: string }
  | { kind: 'pipe'; name: string };
// An address to listen or connect on. `release` frees what the address borrows
// (an open directory fd); call it once the socket is closed or the connect is done.
export interface SocketAddress { path: string; release(): void }

// A flag marks a feature this host can run; when off, the feature is hidden and refused.
export interface PlatformCapabilities { remoteSystems: boolean; fuseUnion: boolean; voice: boolean }

export interface Platform {
  capabilities: PlatformCapabilities;
  // True when SIGTERM lets the target run its shutdown handler; false where it
  // is `TerminateProcess` (the target gets no chance to flush or reap children).
  softSigterm: boolean;
  // Variables the claude CLI needs on this host, merged UNDER the caller's env.
  cliEnv(): Record<string, string>;
  // The spelling the claude CLI's `getcwd()` reports for an existing directory
  // (it names its transcript dir after that spelling); null when p cannot be
  // resolved (it does not exist yet).
  canonicalPath(p: string): string | null;
  // `{shell}` → the login shell running the string; `{argv}` → executable + args.
  commandFor(spec: ExecSpec): { command: string; args: string[] };
  // Base spawn options; spread FIRST so a call site's own options win.
  spawnOptions(role: SpawnRole): { detached?: boolean; windowsHide?: boolean };
  // One process, by handle where the caller has one. Throws like `process.kill`.
  killProcess(target: number | ChildHandle, signal: KillSignal): void;
  // The group a `group`/`daemon` child leads. Throws if there is none.
  killGroup(pid: number, signal: KillSignal): void;
  // A `CLAUDE_BIN` / backend launch template → argv.
  splitCommand(line: string): string[];
  // Equality key for two host paths.
  pathKey(p: string): string;
  // The argv a local terminal runs when its caller names no program — the
  // user's login shell — or null where cc has no pty helper for this host, and
  // `LocalSystem.openTerminal` refuses PTY_UNAVAILABLE.
  terminalShell(): string[] | null;
  // Where a root-lock holder whose token hashes to `token8` listens. `store`
  // whenever the store can hold the socket; `storeUsable: false` (a store that
  // refused a socket) asks for the fallback.
  rootLockEndpoint(lockDir: string, token8: string, opts?: { storeUsable?: boolean }): RootLockSock;
  // The address THIS process reaches a recorded endpoint at — to listen on its
  // own, or to probe another holder's.
  socketConnectPath(lockDir: string, sock: RootLockSock): SocketAddress;
}
