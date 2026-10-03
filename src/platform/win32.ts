// Windows host: Git for Windows' bash stands in for the POSIX shell, a process
// tree is stopped with `taskkill /T /F`, and paths compare case-insensitively.
// Built as a factory over injected env/fs/exec so the logic is unit-testable on
// any host; `win32Platform` binds it to this process.
//
// `path.win32` throughout, never `path`: the host `path` is POSIX when the
// factory runs under a test on Linux.

import path from 'node:path';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import type { ChildHandle, KillSignal, Platform } from './platform.ts';

const w = path.win32;

export type Win32Env = Record<string, string | undefined>;

export interface Win32Deps {
  env: Win32Env;
  exists: (p: string) => boolean;
  execFileSync: (file: string, args: string[], opts: { windowsHide: boolean; timeout: number; stdio: 'ignore' }) => unknown;
  realpathNative: (p: string) => string;
  realpathJs: (p: string) => string;
}

function bashCandidates(env: Win32Env, exists: (p: string) => boolean): string[] {
  const out: string[] = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) out.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  // `Git\cmd` (the only dir the installer puts on PATH) and `Git\bin` both hold git.exe.
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (!dir || !exists(w.join(dir, 'git.exe'))) continue;
    out.push(w.join(dir, '..', 'bin', 'bash.exe'), w.join(dir, 'bash.exe'));
  }
  if (env.LOCALAPPDATA) out.push(w.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  if (env.ProgramFiles) out.push(w.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  return out;
}

// The first existing candidate. Throws, listing every place looked at.
export function resolveGitBash(env: Win32Env, exists: (p: string) => boolean): string {
  const candidates = bashCandidates(env, exists);
  for (const c of candidates) if (exists(c)) return w.normalize(c);
  throw new Error(`Git for Windows' bash.exe not found — install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH (looked in: ${candidates.join(', ') || 'nowhere: no candidate locations'})`);
}

// Git's install root from its bash: `<root>\bin\bash.exe` or `<root>\usr\bin\bash.exe`.
export function gitRootOfBash(bash: string): string {
  const bin = w.dirname(bash);
  const up = w.dirname(bin);
  return w.basename(up).toLowerCase() === 'usr' ? w.dirname(up) : up;
}

export function taskkillArgv(pid: number, env: Win32Env = process.env): [string, string[]] {
  const root = env.SystemRoot || 'C:\\Windows';
  return [w.join(root, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)]];
}

export function createWin32Platform(overrides: Partial<Win32Deps> = {}): Platform {
  const d: Win32Deps = {
    env: process.env,
    exists: existsSync,
    execFileSync: nodeExecFileSync as Win32Deps['execFileSync'],
    realpathNative: realpathSync.native,
    realpathJs: realpathSync,
    ...overrides,
  };

  // Memoise success only: installing Git later takes effect without a restart.
  let bash: string | null = null;
  const gitBash = (): string => (bash ??= resolveGitBash(d.env, d.exists));
  const gitRoot = (): string => gitRootOfBash(gitBash());

  const mapTool = (name: string): string => {
    if (name === 'bash') return gitBash();
    if (name === 'sh') return w.join(gitRoot(), 'bin', 'sh.exe');
    if (name === 'env') return w.join(gitRoot(), 'usr', 'bin', 'env.exe');
    return name;
  };

  // Tree kill by parent pid; needs no group leader. Throws on non-zero exit,
  // with `code: 'ESRCH'` for taskkill's "not found" (128).
  const taskkill = (pid: number): void => {
    const [file, args] = taskkillArgv(pid, d.env);
    try {
      d.execFileSync(file, args, { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { status?: number };
      if (err.status === 128) throw Object.assign(new Error(`kill ESRCH: no process ${pid}`), { code: 'ESRCH' });
      throw e;
    }
  };

  return {
    capabilities: { remoteSystems: false, fuseUnion: false, voice: false },
    softSigterm: false,

    cliEnv(): Record<string, string> {
      if (d.env.CLAUDE_CODE_GIT_BASH_PATH) return {};
      try { return { CLAUDE_CODE_GIT_BASH_PATH: gitBash() }; }
      catch { return {}; }
    },

    canonicalPath(p) {
      try { return d.realpathNative(p); } catch { /* a junction native cannot open */ }
      try { return d.realpathNative(d.realpathJs(p)); } catch { return null; }
    },

    // Git for Windows' /etc/profile defaults MSYS2_PATH_TYPE to `inherit`
    // (verified: `bash -lc` under a PATH of node, Git\cmd, claude's dir resolves
    // node, npm and claude), so the login shell keeps the inherited PATH and no
    // env.exe wrapper is needed.
    commandFor(spec) {
      if ('shell' in spec) return { command: gitBash(), args: ['-lc', spec.shell] };
      const [head, ...rest] = spec.argv;
      if (head === 'env') {
        // `env A=1 bash script`: the program env runs is looked up on a PATH that lacks bash.
        const i = rest.findIndex(a => !a.includes('='));
        if (i >= 0) rest[i] = mapTool(rest[i]);
      }
      return { command: mapTool(head), args: rest };
    },

    // Under libuv `detached` is DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no
    // console, and the child leaves libuv's kill-on-close job. A console
    // grandchild of a console-less parent allocates a VISIBLE console, so only
    // `daemon` (which must outlive cc) is detached; `/T` needs no group leader.
    spawnOptions(role) {
      return role === 'daemon' ? { detached: true, windowsHide: true } : { windowsHide: true };
    },

    killProcess(target: number | ChildHandle, signal: KillSignal) {
      const pid = typeof target === 'number' ? target : target.pid;
      if (pid != null) {
        try { taskkill(pid); return; } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') throw e;
          // e.g. "Access denied" under an SSH logon: fall back to a plain kill.
        }
      }
      if (typeof target === 'number') process.kill(target, signal);
      else target.kill(signal);
    },

    killGroup(pid) {
      taskkill(pid);
    },

    // Whitespace-separated; `"…"` groups (quotes removed); backslashes literal.
    splitCommand(line) {
      const out: string[] = [];
      let cur = '';
      let inQuote = false;
      for (const ch of line) {
        if (ch === '"') inQuote = !inQuote;
        else if (!inQuote && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; }
        else cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    },

    pathKey(p) {
      // `\\?\C:\x` is the same file as `C:\x`; UNC (`\\?\UNC\…`) keeps its prefix.
      let n = w.normalize(p).replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
      if (n.length > 1 && n.endsWith('\\') && !/^[A-Za-z]:\\$/.test(n)) n = n.slice(0, -1);
      return n.toLowerCase();
    },
  };
}

export const win32Platform: Platform = createWin32Platform();
