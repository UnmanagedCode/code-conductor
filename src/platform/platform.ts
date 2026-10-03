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
}
