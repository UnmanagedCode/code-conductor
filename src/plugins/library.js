import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot, orchStoreRoot, validateName } from '../projects.js';
import { httpError } from './registry.js';
import { runGit } from '../worktrees.js';

// Plugin Library — a catalog of installable plugins (git repo URLs) offered
// alongside the discovered-plugins list in Settings → Plugins. Installing
// clones the repo into the projects root; the existing discovery/enable flow
// (registry.js) takes it from there once it has a conductor.plugin.json.
// Installing never enables or starts anything.
//
// Catalog = DEFAULT_ENTRIES, overlaid by drop-in manifests read from
// `<orchStoreRoot()>/plugins/library/*.json` (one JSON object per file):
//   { "id": "...", "name": "...", "description": "...", "repo": "https://...",
//     "postClone": "...", "postPull": "..." }
// id/name/repo are required; description/postClone/postPull are optional. A
// dropped file whose id matches a built-in entry overrides it.
// Malformed/incomplete files are skipped with a warning — never crash the list.
//
// postClone/postPull are shell commands run (cwd = the project directory)
// after a successful clone / pull respectively — e.g. to install the
// plugin's own dependencies. This is a code-execution surface; acceptable
// here because built-in entries are trusted and drop-in files come from
// trusted local tooling (the same trust stance already applies to a
// plugin's own manifest-declared `backend.start`). Execution stays simple
// (`bash -lc`), bounded (timeout + output cap), and its full output is
// always surfaced back to the caller, never silently swallowed.

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'git:']);
const CLONE_TIMEOUT_MS = 120_000;
const POST_HOOK_TIMEOUT_MS = 300_000; // longer than clone — installs pull deps (npm, browser binaries, ...)
const HOOK_OUTPUT_CAP = 16 * 1024; // mirrors worktrees.js's HOOK_OUTPUT_CAP / supervisor.js's OUTPUT_CAP

const DEFAULT_ENTRIES = [
  {
    id: 'code-share',
    name: 'Code Share',
    description: 'Share code snippets and sync files between conductor projects.',
    repo: 'https://github.com/UnmanagedCode/code-share',
  },
  {
    id: 'code-playwright',
    name: 'Code Playwright',
    description: 'Playwright + Chromium glue for visual UI debugging.',
    repo: 'https://github.com/UnmanagedCode/code-playwright',
    postClone: 'bash install.sh',
    postPull: 'bash install.sh',
  },
];

function libraryDir() {
  return path.join(orchStoreRoot(), 'plugins', 'library');
}

async function readLibraryEntries() {
  const byId = new Map(DEFAULT_ENTRIES.map(e => [e.id, e]));
  let names;
  try { names = await fs.readdir(libraryDir()); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn(`pluginLibrary: failed to read library dir: ${e.message}`);
    return [...byId.values()];
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(libraryDir(), name);
    let entry;
    try { entry = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { console.warn(`pluginLibrary: skipping malformed ${file}: ${e.message}`); continue; }
    if (typeof entry?.id !== 'string' || !entry.id
      || typeof entry.name !== 'string' || !entry.name
      || typeof entry.repo !== 'string' || !entry.repo) {
      console.warn(`pluginLibrary: skipping ${file}: missing required id/name/repo`);
      continue;
    }
    byId.set(entry.id, {
      id: entry.id, name: entry.name, description: entry.description ?? '', repo: entry.repo,
      ...(typeof entry.postClone === 'string' ? { postClone: entry.postClone } : {}),
      ...(typeof entry.postPull === 'string' ? { postPull: entry.postPull } : {}),
    });
  }
  return [...byId.values()];
}

// Last non-empty path segment of the repo URL, `.git` suffix stripped —
// e.g. https://github.com/org/foo(.git) -> "foo".
function deriveProjectName(repoUrl) {
  let u;
  try { u = new URL(repoUrl); } catch { return null; }
  const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

function validateRepoUrl(repoUrl) {
  let u;
  try { u = new URL(repoUrl); }
  catch { throw httpError(400, `invalid repo URL '${repoUrl}'`); }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    throw httpError(400, `unsupported repo URL scheme '${u.protocol}' — only http(s)/git are allowed`);
  }
}

// Never throws — mirrors runGit's {code,stdout,stderr} shape (src/worktrees.js),
// but can't reuse it directly since runGit always does `-C <existing cwd>`
// and the clone destination doesn't exist yet.
function cloneRepo(url, destDir) {
  return new Promise((resolve) => {
    execFile('git', ['clone', '--', url, destDir], {
      cwd: projectsRoot(),
      timeout: CLONE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ code: typeof err.code === 'number' ? err.code : 1, stdout: stdout ?? '', stderr: stderr ?? err.message ?? '' });
      } else {
        resolve({ code: 0, stdout, stderr });
      }
    });
  });
}

// Runs an arbitrary postClone/postPull command via `bash -lc` — the same
// invocation style manifest `backend.start` and supervisor.js's spawnChild()
// already use for plugin-declared shell commands. Detached + process-group
// kill on timeout (mirrors worktrees.js's runPostWorktreeHook) rather than
// execFile's built-in timeout, since a command like `npm install` or a
// browser-binary downloader can spawn grandchildren that a plain kill of
// the direct child would orphan. Never rejects.
function runHookCommand(command, cwd, { timeoutMs = POST_HOOK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let output = '';
    const proc = spawn('bash', ['-lc', command], { cwd, env: process.env, detached: true });
    const onData = (d) => {
      output += d.toString();
      if (output.length > HOOK_OUTPUT_CAP) output = output.slice(-HOOK_OUTPUT_CAP);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    let timedOut = false;
    const killGroup = () => {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      }, 100).unref();
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output: output.trimEnd() });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, output: e.message });
    });
  });
}

export function createPluginLibrary({ pluginHost = null, _cloneImpl = null, _runHookImpl = null } = {}) {
  const clone = _cloneImpl ?? cloneRepo;
  const runHookImpl = _runHookImpl ?? runHookCommand;

  // Never throws — `command` unset means "nothing to run" (null). A failed
  // hook is reported, never masked and never fatal to its caller (see
  // install()/update() below): the clone/pull it follows already succeeded.
  async function runHook(command, cwd) {
    if (!command) return null;
    const r = await runHookImpl(command, cwd);
    return { ran: true, ok: r.code === 0, code: r.code, tail: (r.output ?? '').slice(-4000) };
  }

  async function list() {
    const entries = await readLibraryEntries();
    return Promise.all(entries.map(async (entry) => {
      const name = deriveProjectName(entry.repo);
      let installed = false;
      if (name) {
        try { installed = (await fs.stat(path.join(projectsRoot(), name))).isDirectory(); }
        catch { /* not installed */ }
      }
      return { ...entry, installed, installedAs: installed ? name : null };
    }));
  }

  async function install(id) {
    const entries = await readLibraryEntries();
    const entry = entries.find(e => e.id === id);
    if (!entry) throw httpError(404, `unknown library plugin '${id}'`);
    validateRepoUrl(entry.repo);
    const name = deriveProjectName(entry.repo);
    if (!name) throw httpError(400, `could not derive a project name from repo URL '${entry.repo}'`);
    validateName(name);

    const target = path.join(projectsRoot(), name);
    let exists = false;
    try { await fs.stat(target); exists = true; } catch { /* absent — good */ }
    if (exists) throw httpError(409, `'${name}' is already installed`);

    const result = await clone(entry.repo, target);
    if (result.code !== 0) {
      // A failed/timed-out clone can leave a partial dir — clear it so a
      // retry isn't permanently blocked by the "already installed" check.
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      const tail = (result.stderr || result.stdout || '').slice(-4000);
      throw httpError(502, `git clone failed for '${entry.repo}'`, { tail });
    }

    // Cloned + discoverable only — never auto-enable/start.
    if (pluginHost) await pluginHost.rescan();

    // The clone succeeded and is already discoverable — a postClone failure
    // is reported, not fatal, and the clone is NOT rolled back (unlike a
    // failed clone above). The documented retry path is Update, which reruns
    // postPull (code-playwright sets both to the identical command).
    const postClone = await runHook(entry.postClone, target);
    return { id, name, project: name, path: target, postClone };
  }

  async function update(id) {
    const entries = await readLibraryEntries();
    const entry = entries.find(e => e.id === id);
    if (!entry) throw httpError(404, `unknown library plugin '${id}'`);
    const name = deriveProjectName(entry.repo);
    if (!name) throw httpError(400, `could not derive a project name from repo URL '${entry.repo}'`);

    const target = path.join(projectsRoot(), name);
    try { await fs.stat(target); }
    catch { throw httpError(404, `'${name}' is not installed`); }

    // ff-only never mutates on failure (diverged/dirty/no-remote/not-a-repo
    // all refuse cleanly) — surface the tail rather than attempting a merge.
    const pull = await runGit(target, ['pull', '--ff-only']);
    if (pull.code !== 0) {
      const tail = (pull.stderr || pull.stdout || '').slice(-4000);
      throw httpError(502, `git pull failed for '${name}'`, { tail });
    }

    // A pulled manifest/version bump should surface immediately, same as install().
    if (pluginHost) await pluginHost.rescan();

    const postPull = await runHook(entry.postPull, target);
    return { id, name, project: name, path: target, postPull };
  }

  return { list, install, update };
}
