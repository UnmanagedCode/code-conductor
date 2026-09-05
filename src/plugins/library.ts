import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot, orchStoreRoot, validateName, resolveProjectDir } from '../projects.ts';
import { httpError } from '../httpError.ts';
import { getProjectUpstreamStatus } from '../worktrees.ts';
import { runGitLive, fetchOriginBounded } from '../gitLive.ts';
import { runGroupedCommand, GROUP_OUTPUT_CAP } from '../groupedCommand.ts';
import { localSystem } from '../systems/registry.ts';

// Plugin Library — a catalog of installable plugins (git repo URLs) offered
// alongside the discovered-plugins list in Settings → Plugins. Installing
// clones the repo into the projects root, then enables the freshly-discovered
// plugin by default (its conventions go active immediately). Enabling is
// start-neutral — a backend starts lazily on first use — so install never
// launches a process; an invalid/conflicting manifest is left disabled.
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

// A library catalog entry. `description`/`postClone`/`postPull` are optional
// (a drop-in manifest may omit them).
interface LibraryEntry {
  id: string;
  name: string;
  description: string;
  repo: string;
  postClone?: string;
  postPull?: string;
}

const DEFAULT_ENTRIES: LibraryEntry[] = [
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
  {
    id: 'code-hub',
    name: 'Code Hub',
    description: 'Launch, monitor, stop, and share the other webapps in your workspace — from your phone.',
    repo: 'https://github.com/UnmanagedCode/code-hub',
    postClone: 'npm install',
    postPull: 'npm install',
  },
  {
    id: 'code-karpathy-wiki',
    name: 'Code Karpathy Wiki',
    description: 'Durable-knowledge wiki conventions: a per-project .wiki/ plus the conductor\'s .conduct/wiki/.',
    repo: 'https://github.com/UnmanagedCode/code-karpathy-wiki',
  },
  {
    id: 'code-kanban',
    name: 'Code Kanban',
    description: 'A persistent, file-backed private task board for the conductor and its workers.',
    repo: 'https://github.com/UnmanagedCode/code-kanban',
    postClone: 'npm install',
    postPull: 'npm install',
  },
  {
    id: 'code-dialectic',
    name: 'Code Dialectic',
    description: 'Runs a structured dialectic (thesis → antithesis → synthesis) between two Dialectician workers to stress-test an idea or decision.',
    repo: 'https://github.com/UnmanagedCode/code-dialectic',
  },
  {
    id: 'code-mutant',
    name: 'Code Mutant',
    description: 'Mutation-proves test-coverage claims during review: a prover runs real mutants and reports survivors as blocking findings.',
    repo: 'https://github.com/UnmanagedCode/code-mutant',
  },
];

// The plugin-host surface install()/update() read (see createPluginHost in
// registry.ts — its PluginRow type is internal, so this is the read subset).
interface PluginHostLike {
  rescan(): Promise<unknown>;
  list(): Promise<Array<{ id: string | null; project: string; state: string }>>;
  enable(id: string): Promise<unknown>;
  restart(id: string): Promise<unknown>;
}

// The git/hook command results, structurally matching gitLive.GitLiveResult
// and runHookCommand's shape.
interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type CloneImpl = (url: string, destDir: string, opts?: { onChunk?: (s: string) => void }) => Promise<GitCommandResult>;
type PullImpl = (cwd: string, opts?: { onChunk?: (s: string) => void }) => Promise<GitCommandResult>;
type RunHookImpl = (command: string, cwd: string, opts?: { timeoutMs?: number; onChunk?: (s: string) => void }) => Promise<{ code: number; output: string }>;

// update()'s restart outcome: either an attempt (ids restarted, ok/error) or
// a deliberate skip — 'postPull-failed' means a broken postPull left the
// checkout in a half-built state, so restarting into it would trade a
// healthy child serving old code for a crash-looping one serving no code at
// all. A skip is never a failure and carries no ids/ok/error of its own.
type RestartOutcome = { ids: string[]; ok: boolean; error: string | null } | { skipped: 'postPull-failed' };

// Only a RUNNING child holds stale code; a stopped backend starts lazily on
// first use and picks the pull up by itself, so update never starts one.
// Split from the restart loop below so update() can decide whether a failed
// postPull should SKIP the restart (vs. report "nothing was running") from
// the same eligible set the restart loop would use — the skip claim ("your
// backend was left running the old code") is only true when this is non-empty.
async function resolveRunningIds(host: PluginHostLike, projectName: string): Promise<{ ids: string[] } | { error: string }> {
  try {
    const ids = (await host.list())
      .filter(r => r.project === projectName && typeof r.id === 'string' && (r.state === 'ready' || r.state === 'starting'))
      .map(r => r.id as string);
    return { ids };
  } catch (e) { return { error: errMsg(e) }; }
}

// Never throws — a restart failure is soft, exactly like a failed postPull:
// the pull already landed on disk.
async function restartIds(host: PluginHostLike, ids: string[], onChunk: (s: string) => void): Promise<RestartOutcome> {
  const done: string[] = [];
  for (const id of ids) {
    try { await host.restart(id); done.push(id); onChunk(`\n[restarted ${id}]\n`); }
    catch (e) { return { ids: done, ok: false, error: `${id}: ${errMsg(e)}` }; }
  }
  return { ids: done, ok: true, error: null };
}

function libraryDir(): string {
  return path.join(orchStoreRoot(), 'plugins', 'library');
}

// `skipped` names the per-file drop-ins that were REJECTED — a malformed one, or
// one missing a required field. Reported on GET /api/plugins/library and shown in
// the Settings → Plugins Library status line, because a drop-in that silently
// never appears is indistinguishable from one that was never written. A
// wrong-extension file is a deliberate ignore, NOT a skip, and is never listed.
async function readLibraryEntries(): Promise<{ entries: LibraryEntry[]; skipped: Array<{ file: string; reason: string }> }> {
  const byId = new Map(DEFAULT_ENTRIES.map(e => [e.id, e]));
  const skipped: Array<{ file: string; reason: string }> = [];
  let names: string[];
  try { names = await fs.readdir(libraryDir()); }
  catch (e) {
    // An unreadable library DIRECTORY stays a logged degradation: it has no
    // per-file identity to report, and the built-in entries still serve.
    if (errCode(e) !== 'ENOENT') console.warn(`pluginLibrary: failed to read library dir: ${errMsg(e)}`);
    return { entries: [...byId.values()], skipped };
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(libraryDir(), name);
    let entry: unknown;
    try { entry = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) {
      console.warn(`pluginLibrary: skipping malformed ${file}: ${errMsg(e)}`);
      skipped.push({ file: name, reason: errMsg(e) });
      continue;
    }
    const rec = (entry && typeof entry === 'object' && !Array.isArray(entry))
      ? entry as { id?: unknown; name?: unknown; description?: unknown; repo?: unknown; postClone?: unknown; postPull?: unknown }
      : null;
    if (!rec || typeof rec.id !== 'string' || !rec.id
      || typeof rec.name !== 'string' || !rec.name
      || typeof rec.repo !== 'string' || !rec.repo) {
      console.warn(`pluginLibrary: skipping ${file}: missing required id/name/repo`);
      skipped.push({ file: name, reason: 'missing required id/name/repo' });
      continue;
    }
    byId.set(rec.id, {
      id: rec.id, name: rec.name,
      description: typeof rec.description === 'string' ? rec.description : '',
      repo: rec.repo,
      ...(typeof rec.postClone === 'string' ? { postClone: rec.postClone } : {}),
      ...(typeof rec.postPull === 'string' ? { postPull: rec.postPull } : {}),
    });
  }
  return { entries: [...byId.values()], skipped };
}

// Last non-empty path segment of the repo URL, `.git` suffix stripped —
// e.g. https://github.com/org/foo(.git) -> "foo".
function deriveProjectName(repoUrl: string): string | null {
  let u: URL;
  try { u = new URL(repoUrl); } catch { return null; }
  const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

function validateRepoUrl(repoUrl: string): void {
  let u: URL;
  try { u = new URL(repoUrl); }
  catch { throw httpError(400, `invalid repo URL '${repoUrl}'`); }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    throw httpError(400, `unsupported repo URL scheme '${u.protocol}' — only http(s)/git are allowed`);
  }
}

function cloneRepo(url: string, destDir: string, { onChunk }: { onChunk?: (s: string) => void } = {}): Promise<GitCommandResult> {
  return runGitLive(['clone', '--', url, destDir], projectsRoot(), { timeoutMs: CLONE_TIMEOUT_MS, onChunk });
}

function pullRepo(cwd: string, { onChunk }: { onChunk?: (s: string) => void } = {}): Promise<GitCommandResult> {
  return runGitLive(['pull', '--ff-only'], cwd, { timeoutMs: CLONE_TIMEOUT_MS, onChunk });
}

// Runs an arbitrary postClone/postPull command via `bash -lc` — the same
// invocation style manifest `backend.start` and supervisor.ts's spawnChild()
// already use for plugin-declared shell commands. Detached + process-group
// kill on timeout rather than execFile's built-in timeout, since a command like
// `npm install` or a browser-binary downloader can spawn grandchildren that a
// plain kill of the direct child would orphan. Never rejects.
function runHookCommand(command: string, cwd: string, { timeoutMs = POST_HOOK_TIMEOUT_MS, onChunk }: { timeoutMs?: number; onChunk?: (s: string) => void } = {}): Promise<{ code: number; output: string }> {
  return runGroupedCommand({ shell: command }, {
    cwd, env: process.env, timeoutMs, cap: GROUP_OUTPUT_CAP, onChunk,
  }).then(r => ({ code: r.code, output: r.output.trimEnd() }));
}

export function createPluginLibrary({ pluginHost = null, _cloneImpl = null, _pullImpl = null, _runHookImpl = null }: {
  pluginHost?: PluginHostLike | null;
  _cloneImpl?: CloneImpl | null;
  _pullImpl?: PullImpl | null;
  _runHookImpl?: RunHookImpl | null;
} = {}): {
  list(): Promise<{
    entries: Array<LibraryEntry & { installed: boolean; installedAs: string | null; updateAvailable: boolean; behind: number | null }>;
    skipped: Array<{ file: string; reason: string }>;
  }>;
  install(id: string, opts?: { onChunk?: (phase: 'clone' | 'hook', text: string) => void; onValidated?: () => void }): Promise<{ id: string; name: string; project: string; path: string; postClone: { ran: boolean; ok: boolean; code: number; tail: string } | null }>;
  update(id: string, opts?: { onChunk?: (phase: 'pull' | 'hook' | 'restart', text: string) => void; onValidated?: () => void }): Promise<{ id: string; name: string; project: string; path: string; postPull: { ran: boolean; ok: boolean; code: number; tail: string } | null; restarted: RestartOutcome | null }>;
} {
  const clone = _cloneImpl ?? cloneRepo;
  const pull = _pullImpl ?? pullRepo;
  const runHookImpl = _runHookImpl ?? runHookCommand;

  // Never throws — `command` unset means "nothing to run" (null). A failed
  // hook is reported, never masked and never fatal to its caller (see
  // install()/update() below): the clone/pull it follows already succeeded.
  async function runHook(command: string | undefined, cwd: string, onChunk: (s: string) => void): Promise<{ ran: boolean; ok: boolean; code: number; tail: string } | null> {
    if (!command) return null;
    const r = await runHookImpl(command, cwd, { onChunk });
    return { ran: true, ok: r.code === 0, code: r.code, tail: (r.output ?? '').slice(-4000) };
  }

  async function list(): Promise<{
    entries: Array<LibraryEntry & { installed: boolean; installedAs: string | null; updateAvailable: boolean; behind: number | null }>;
    skipped: Array<{ file: string; reason: string }>;
  }> {
    const { entries, skipped } = await readLibraryEntries();
    const enriched = await Promise.all(entries.map(async (entry) => {
      const name = deriveProjectName(entry.repo);
      let installed = false;
      if (name) {
        try { installed = (await fs.stat(path.join(projectsRoot(), name))).isDirectory(); }
        catch { /* not installed */ }
      }
      let updateAvailable = false;
      let behind: number | null = null;
      if (installed) {
        // Cached refs go stale between visits — a bounded, best-effort fetch
        // first means "update available" reflects the real remote, not
        // whatever was last fetched manually (see fetchOriginBounded in gitLive.ts).
        const target = path.join(projectsRoot(), name as string);
        await fetchOriginBounded(target);
        // The library clone is cc's own, never a project on a system: always local.
        const status = await getProjectUpstreamStatus(localSystem(), target);
        behind = status.behind;
        updateAvailable = typeof status.behind === 'number' && status.behind > 0;
      }
      return { ...entry, installed, installedAs: installed ? name : null, updateAvailable, behind };
    }));
    return { entries: enriched, skipped };
  }

  async function install(id: string, { onChunk, onValidated }: { onChunk?: (phase: 'clone' | 'hook', text: string) => void; onValidated?: () => void } = {}): Promise<{ id: string; name: string; project: string; path: string; postClone: { ran: boolean; ok: boolean; code: number; tail: string } | null }> {
    const { entries } = await readLibraryEntries();
    const entry = entries.find(e => e.id === id);
    if (!entry) throw httpError(404, `unknown library plugin '${id}'`);
    validateRepoUrl(entry.repo);
    const name = deriveProjectName(entry.repo);
    if (!name) throw httpError(400, `could not derive a project name from repo URL '${entry.repo}'`);
    validateName(name);

    const target = path.join(projectsRoot(), name);
    // resolveProjectDir, not a bare stat on `target`: an ADOPTED project of the
    // same name holds the name without occupying that in-root path, and cloning
    // over it would mint a second identity for one project name.
    let taken = false;
    try { taken = (await resolveProjectDir(name)) !== null; } catch { taken = true; }
    if (taken) throw httpError(409, `'${name}' is already installed`);

    // Past this point we're actually doing work (clone + hook) — the route
    // uses this as the signal to switch its response into streaming mode.
    onValidated?.();

    const result = await clone(entry.repo, target, { onChunk: (text) => onChunk?.('clone', text) });
    if (result.code !== 0) {
      // A failed/timed-out clone can leave a partial dir — clear it so a
      // retry isn't permanently blocked by the "already installed" check.
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      const tail = (result.stderr || result.stdout || '').slice(-4000);
      throw httpError(502, `git clone failed for '${entry.repo}'`, { tail });
    }

    // A freshly installed plugin defaults to enabled (its conventions become
    // active immediately). enable() is start-neutral — backends start lazily on
    // first use — so this never launches a process at install time. Only a
    // cleanly-discovered plugin is auto-enabled; an invalid/conflicting manifest
    // is left for the user to resolve. Best-effort: a failure here doesn't undo
    // the successful clone.
    if (pluginHost) {
      await pluginHost.rescan();
      try {
        const row = (await pluginHost.list()).find(r => r.project === name && r.state === 'discovered');
        if (row?.id) await pluginHost.enable(row.id);
      } catch (e) {
        onChunk?.('hook', `\n[auto-enable skipped: ${errMsg(e)}]\n`);
      }
    }

    // The clone succeeded and is already discoverable — a postClone failure
    // is reported, not fatal, and the clone is NOT rolled back (unlike a
    // failed clone above). The documented retry path is Update, which reruns
    // postPull (code-playwright sets both to the identical command).
    const postClone = await runHook(entry.postClone, target, (text) => onChunk?.('hook', text));
    return { id, name, project: name, path: target, postClone };
  }

  async function update(id: string, { onChunk, onValidated }: { onChunk?: (phase: 'pull' | 'hook' | 'restart', text: string) => void; onValidated?: () => void } = {}): Promise<{ id: string; name: string; project: string; path: string; postPull: { ran: boolean; ok: boolean; code: number; tail: string } | null; restarted: RestartOutcome | null }> {
    const { entries } = await readLibraryEntries();
    const entry = entries.find(e => e.id === id);
    if (!entry) throw httpError(404, `unknown library plugin '${id}'`);
    const name = deriveProjectName(entry.repo);
    if (!name) throw httpError(400, `could not derive a project name from repo URL '${entry.repo}'`);

    const target = path.join(projectsRoot(), name);
    try { await fs.stat(target); }
    catch { throw httpError(404, `'${name}' is not installed`); }

    // Past this point we're actually doing work (pull + hook) — the route
    // uses this as the signal to switch its response into streaming mode.
    onValidated?.();

    // ff-only never mutates on failure (diverged/dirty/no-remote/not-a-repo
    // all refuse cleanly) — surface the tail rather than attempting a merge.
    const pullResult = await pull(target, { onChunk: (text) => onChunk?.('pull', text) });
    if (pullResult.code !== 0) {
      const tail = (pullResult.stderr || pullResult.stdout || '').slice(-4000);
      throw httpError(502, `git pull failed for '${name}'`, { tail });
    }

    // A pulled manifest/version bump should surface immediately, same as install().
    if (pluginHost) await pluginHost.rescan();

    const postPull = await runHook(entry.postPull, target, (text) => onChunk?.('hook', text));
    // Resolve the eligible-to-restart set FIRST, before looking at postPull —
    // "nothing was running" must report the same `null` regardless of postPull,
    // and a skip claim ("your backend was left on the old code") is only true
    // when a backend was actually found running.
    let restarted: RestartOutcome | null = null;
    if (pluginHost) {
      const running = await resolveRunningIds(pluginHost, name);
      if ('error' in running) {
        restarted = { ids: [], ok: false, error: running.error };
      } else if (running.ids.length === 0) {
        restarted = null;
      } else if (postPull && !postPull.ok) {
        // A postPull that ran and failed leaves the checkout half-built
        // (broken deps, an incomplete migration) — restarting into that
        // trades a healthy child serving old code for one that crash-loops
        // serving no code at all. Skip the restart entirely rather than
        // attempt-and-fail; the running backend is left exactly as it was.
        restarted = { skipped: 'postPull-failed' };
        onChunk?.('restart', '\n[skipped restart: post-update command failed]\n');
      } else {
        restarted = await restartIds(pluginHost, running.ids, (t) => onChunk?.('restart', t));
      }
    }
    return { id, name, project: name, path: target, postPull, restarted };
  }

  return { list, install, update };
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
