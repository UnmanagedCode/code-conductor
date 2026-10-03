// Tool detection and environment composition shared by setup.mjs and
// launch.mjs. Pure over an injected `env` / `exists` so Linux tests exercise
// the Windows path logic; every path op is `path.win32`.
import fs from 'node:fs';
import path from 'node:path';

const w = path.win32;

// Windows env names are case-insensitive; an injected plain object is not.
export function envKey(env, name) {
  const lower = name.toLowerCase();
  return Object.keys(env).find((k) => k.toLowerCase() === lower);
}
export function getEnv(env, name) {
  const k = envKey(env, name);
  return k === undefined ? undefined : env[k];
}

const splitPath = (value) => (value || '').split(';').filter(Boolean);

// `name.exe` on PATH. Only `.exe` counts: an npm `.cmd` shim is not a binary
// cc can spawn directly.
export function findOnPath(name, env, exists = fs.existsSync) {
  for (const dir of splitPath(getEnv(env, 'PATH'))) {
    const candidate = w.join(dir.replace(/^"|"$/g, ''), `${name}.exe`);
    if (exists(candidate)) return candidate;
  }
  return null;
}

// Git's install root from any of its exes (`cmd\git.exe`, `bin\git.exe`,
// `mingw64\bin\git.exe`).
function gitRootOf(gitExe) {
  let dir = w.dirname(gitExe);
  if (w.basename(dir).toLowerCase() === 'bin' && /^(mingw64|usr)$/i.test(w.basename(w.dirname(dir)))) {
    return w.dirname(w.dirname(dir));
  }
  if (/^(cmd|bin)$/i.test(w.basename(dir))) return w.dirname(dir);
  return dir;
}

// Git counts only with its bundled `bin\bash.exe`: Git Bash is what claude
// needs on Windows, a bare git.exe is not enough.
export function detectGit(env, exists = fs.existsSync) {
  const candidates = [];
  const onPath = findOnPath('git', env, exists);
  if (onPath) candidates.push(onPath);
  const local = getEnv(env, 'LOCALAPPDATA');
  if (local) candidates.push(w.join(local, 'Programs', 'Git', 'cmd', 'git.exe'));
  const pf = getEnv(env, 'ProgramFiles');
  if (pf) candidates.push(w.join(pf, 'Git', 'cmd', 'git.exe'));
  for (const gitExe of candidates) {
    if (!exists(gitExe)) continue;
    const root = gitRootOf(gitExe);
    if (exists(w.join(root, 'bin', 'bash.exe'))) return { gitExe, cmdDir: w.join(root, 'cmd') };
  }
  return null;
}

export function detectClaude(env, exists = fs.existsSync) {
  const onPath = findOnPath('claude', env, exists);
  if (onPath) return { claudeExe: onPath, dir: w.dirname(onPath) };
  const home = getEnv(env, 'USERPROFILE');
  if (home) {
    const claudeExe = w.join(home, '.local', 'bin', 'claude.exe');
    if (exists(claudeExe)) return { claudeExe, dir: w.dirname(claudeExe) };
  }
  return null;
}

export function defaultProjectsRoot(env) {
  return w.join(getEnv(env, 'USERPROFILE') || '', 'code-conductor');
}

// PATH entries deduplicated case-insensitively, first occurrence wins.
export function dedupePath(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = e.toLowerCase().replace(/[\\/]+$/, '');
    if (!e || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// The server's environment. Bundled node first (so `npm` is the bundled one),
// then Git's `cmd`, then claude's dir. Deliberately sets no CLAUDE_BIN (it is
// whitespace-split, so a path with spaces would break), HOST/PORT, or
// CLAUDE_CODE_GIT_BASH_PATH.
export function launcherEnv({ env, installDir, git, claude }) {
  const out = { ...env };
  const rootKey = envKey(env, 'PROJECTS_ROOT');
  if (rootKey && rootKey !== 'PROJECTS_ROOT') delete out[rootKey];
  const pathKey = envKey(env, 'PATH') || 'Path';
  const head = [w.join(installDir, 'node')];
  if (git) head.push(git.cmdDir);
  if (claude) head.push(claude.dir);
  out[pathKey] = dedupePath([...head, ...splitPath(getEnv(env, 'PATH'))]).join(';');
  out.PROJECTS_ROOT = getEnv(env, 'PROJECTS_ROOT') || defaultProjectsRoot(env);
  return out;
}

function expandVars(value, env) {
  return value.replace(/%([^%]+)%/g, (m, n) => getEnv(env, n) ?? m);
}

// Append `dir` to the user PATH (HKCU\Environment\Path) iff absent. Goes
// through `reg.exe` rather than NSIS ReadRegStr (1024-char truncation) and
// writes REG_EXPAND_SZ without a shell so `%VAR%` entries stay literal.
// `reg(args)` -> {code, stdout, stderr}. Fails closed: only a not-found
// result means "no Path value"; any other failed or unparseable query throws
// without writing, since writing would replace a Path we could not read.
export async function addToUserPath(dir, { reg, env = process.env }) {
  const q = await reg(['query', 'HKCU\\Environment', '/v', 'Path']);
  let current = '';
  const notFound = q.code === 1 || /unable to find/i.test(`${q.stdout}${q.stderr ?? ''}`);
  if (q.code === 0) {
    const m = /^\s*Path\s+REG_\w+\s+(.*)$/im.exec(q.stdout);
    if (!m) throw new Error('reg query HKCU\\Environment Path succeeded but its output could not be parsed');
    current = m[1].replace(/\r$/, '');
  } else if (!notFound) {
    throw new Error(`reg query HKCU\\Environment Path failed (exit ${q.code})`);
  }
  const entries = splitPath(current);
  const want = dir.toLowerCase().replace(/[\\/]+$/, '');
  const present = entries.some((e) => {
    const norm = (s) => s.toLowerCase().replace(/[\\/]+$/, '');
    return norm(e) === want || norm(expandVars(e, env)) === want;
  });
  if (present) return false;
  const next = [...entries, dir].join(';');
  const r = await reg(['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', next, '/f']);
  if (r.code !== 0) throw new Error(`reg add HKCU\\Environment Path failed (exit ${r.code})`);
  return true;
}
