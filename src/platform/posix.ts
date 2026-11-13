import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { posixLoginShell } from '../systems/ptyHost.ts';
import { procStartSync } from '../systems/fuse/driver.ts';
import type { Platform } from './platform.ts';
import { lockDirHash, NO_RELEASE, SOCK_PATH_MAX } from './rootLockAddress.ts';

// The host facts the root-lock addressing reads, injectable so a test can take
// the branch its own host does not.
export interface PosixDeps {
  // `/proc/self/fd` exists (Linux, Android): a long socket path can then be
  // reached through an open fd on its directory.
  procFd: () => boolean;
  tmpdir: () => string;
  realpath: (p: string) => string;
  openDir: (p: string) => number;
  closeFd: (fd: number) => void;
  // `/proc/<pid>/stat` is readable (Linux, Android): a start time is its field 22.
  hasProcStat: () => boolean;
  procStart: (pid: number) => string | null;
  // `ps -o lstart= -p <pid>`'s stdout, or null when ps fails (no such pid, no ps).
  psLstart: (pid: number) => Promise<string | null>;
}

const PS_TIMEOUT_MS = 5000;

function psLstart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (err, stdout) => resolve(err ? null : String(stdout)));
    child.on('error', () => resolve(null));
  });
}

export function createPosixPlatform(overrides: Partial<PosixDeps> = {}): Platform {
  const d: PosixDeps = {
    procFd: () => existsSync('/proc/self/fd'),
    tmpdir: os.tmpdir,
    realpath: realpathSync,
    openDir: (p) => openSync(p, 'r'),
    closeFd: closeSync,
    hasProcStat: () => existsSync('/proc/self/stat'),
    procStart: procStartSync,
    psLstart,
    ...overrides,
  };
  const fits = (p: string): boolean => Buffer.byteLength(p) <= SOCK_PATH_MAX;
  return {
    capabilities: { remoteSystems: true, fuseUnion: true, voice: true },
    softSigterm: true,
    cliEnv() {
      return {};
    },
    canonicalPath(p) {
      return p;
    },
    commandFor(spec) {
      return 'shell' in spec
        ? { command: 'bash', args: ['-lc', spec.shell] }
        : { command: spec.argv[0], args: spec.argv.slice(1) };
    },
    spawnOptions(role) {
      return role === 'child' ? {} : { detached: true };
    },
    killProcess(target, signal) {
      if (typeof target === 'number') process.kill(target, signal);
      else target.kill(signal);
    },
    killGroup(pid, signal) {
      process.kill(-pid, signal);
    },
    // Field 22 of /proc/<pid>/stat (clock ticks since boot) where /proc exists;
    // `ps`'s lstart (macOS) otherwise.
    async processStartTime(pid) {
      if (d.hasProcStat()) return d.procStart(pid);
      const out = (await d.psLstart(pid))?.trim();
      return out ? out : null;
    },
    splitCommand(line) {
      return line.split(/\s+/).filter(Boolean);
    },
    pathKey(p) {
      return p;
    },
    terminalShell() {
      return posixLoginShell();
    },
    // A store socket keeps the lock visible to every same-kernel process that
    // mounts the store, containers included; tmp is the fallback for a long path
    // with no /proc, or a store that cannot hold a socket.
    rootLockEndpoint(lockDir, token8, { storeUsable = true } = {}) {
      const name = `${token8}.sock`;
      if (storeUsable && (fits(path.join(lockDir, name)) || d.procFd())) return { kind: 'store', name };
      let real = lockDir;
      try { real = d.realpath(lockDir); } catch { /* not there yet: hash the spelling */ }
      return { kind: 'tmp', path: path.join(d.tmpdir(), `cc-root-${lockDirHash(real)}-${token8}.sock`) };
    },
    socketConnectPath(lockDir, sock) {
      if (sock.kind !== 'store') return { path: sock.kind === 'tmp' ? sock.path : sock.name, release: NO_RELEASE };
      const full = path.join(lockDir, sock.name);
      if (fits(full) || !d.procFd()) return { path: full, release: NO_RELEASE };
      // Too long to bind or connect directly: name the file through an fd on
      // its directory, held open until the caller is done with the address.
      const fd = d.openDir(lockDir);
      let open = true;
      return {
        path: `/proc/self/fd/${fd}/${sock.name}`,
        release() { if (open) { open = false; d.closeFd(fd); } },
      };
    },
  };
}

export const posixPlatform: Platform = createPosixPlatform();
