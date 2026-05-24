import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Project group names are looser than project names: spaces and slashes
// are allowed so users can type a natural label ("Work", "Side projects",
// "client/Foo"). Bounded length + no control chars so it remains safe to
// render and serialise.
const GROUP_RE = /^[\w][\w \-./]{0,39}$/;
// Directories owned by the orchestrator's worktree feature carry this
// marker path (see src/worktrees.js). Top-level project listing filters
// them out so they aren't presented as standalone projects — they appear
// as a child node under the parent.
const WORKTREE_MARKER = '.hivemind/worktree.json';
// Per-project metadata lives alongside other orchestrator state in the
// project's .hivemind/ dotfolder. Created lazily — projects with
// no metadata simply have no file.
const META_FILE = '.hivemind/project.json';

async function isWorktreeMarkerPresent(dir) {
  try {
    await fs.access(path.join(dir, WORKTREE_MARKER));
    return true;
  } catch {
    return false;
  }
}

export function projectsRoot() {
  return process.env.PROJECTS_ROOT ?? path.join(os.homedir(), 'project');
}

export function claudeProjectsRoot() {
  return process.env.CLAUDE_PROJECTS_ROOT ?? path.join(os.homedir(), '.claude', 'projects');
}

export function encodeCwd(abs) {
  // Mirror Claude Code's own encoding: every char that isn't
  // alphanumeric or a hyphen becomes `-`. This includes underscores!
  // Previously we kept underscores, which silently broke any project
  // path containing `_` (notably the worktree dirs we create at
  // `<project>_worktree_<id>`): the orchestrator's metadata appends
  // landed at `<…>_worktree_<…>` while real claude wrote the actual
  // session to `<…>-worktree-<…>`. Two separate dirs, both half-empty,
  // and resume / history-replay both broke.
  return abs.replace(/[^A-Za-z0-9-]/g, '-');
}

export function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    const err = new Error('invalid project name (must match ^[a-zA-Z0-9._-]+$)');
    err.statusCode = 400;
    throw err;
  }
  return name;
}

export async function listProjects() {
  const root = projectsRoot();
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    // Skip orchestrator-owned worktree dirs — they're surfaced under
    // their parent project, not as top-level projects.
    if (await isWorktreeMarkerPresent(full)) continue;
    const meta = await readProjectMeta(e.name);
    out.push({ name: e.name, path: full, group: meta.group });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function validateGroup(group) {
  if (group === null) return null;
  if (typeof group !== 'string') {
    const err = new Error('group must be a string or null');
    err.statusCode = 400;
    throw err;
  }
  const trimmed = group.trim();
  if (trimmed === '') return null;
  if (!GROUP_RE.test(trimmed)) {
    const err = new Error('invalid group name (1–40 chars, no control chars; spaces / `/`,`.`,`-`,`_` allowed)');
    err.statusCode = 400;
    throw err;
  }
  return trimmed;
}

// Read the project's optional metadata file. Missing file or malformed
// JSON → {group: null}. The dotfolder may not exist yet — that's fine.
export async function readProjectMeta(name) {
  validateName(name);
  const file = path.join(projectsRoot(), name, META_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const obj = JSON.parse(raw);
    const group = typeof obj?.group === 'string' && obj.group.trim() !== ''
      ? obj.group.trim()
      : null;
    return { group };
  } catch (e) {
    if (e.code === 'ENOENT') return { group: null };
    // Malformed JSON or unreadable — degrade to ungrouped rather than
    // throwing. A single console.warn (not an error) so noisy systems
    // don't spam logs on every list.
    console.warn(`projects: failed to read ${file}: ${e.message}`);
    return { group: null };
  }
}

// Write the project's metadata. Atomic rename to avoid torn reads if the
// process dies mid-write. Passing {group: null} clears the field and
// deletes the file if it would otherwise be empty.
export async function writeProjectMeta(name, patch) {
  validateName(name);
  await getProject(name);
  const dir = path.join(projectsRoot(), name, '.hivemind');
  const file = path.join(dir, 'project.json');
  const current = await readProjectMeta(name);
  const next = { ...current, ...patch };
  if ('group' in patch) next.group = validateGroup(patch.group);
  // Drop empty fields so the on-disk file stays minimal.
  for (const k of Object.keys(next)) {
    if (next[k] === null || next[k] === undefined) delete next[k];
  }
  if (Object.keys(next).length === 0) {
    // Nothing to persist — remove the file (and the dotfolder if empty,
    // best-effort). Keeps a freshly-created-then-cleared project tidy.
    try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { await fs.rmdir(dir); } catch { /* not empty / not there — fine */ }
    return next;
  }
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await fs.rename(tmp, file);
  return next;
}

export async function createProject(name) {
  validateName(name);
  const root = projectsRoot();
  const full = path.join(root, name);
  try {
    await fs.mkdir(full, { recursive: false });
  } catch (e) {
    if (e.code === 'EEXIST') {
      const err = new Error(`project '${name}' already exists`);
      err.statusCode = 409;
      throw err;
    }
    throw e;
  }
  // Seed a CLAUDE.md that imports the workspace-wide one at ~/project/CLAUDE.md.
  // Using @../CLAUDE.md so Claude Code's import resolver pulls the workspace
  // file in regardless of where the project ends up being mounted.
  const claudeMdPath = path.join(full, 'CLAUDE.md');
  try {
    await fs.writeFile(claudeMdPath, '@../CLAUDE.md\n', { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return { name, path: full };
}

// Delete the entire project directory. Caller is responsible for first
// killing any running instances and removing worktree registrations
// (the cascade is orchestrated in src/routes.js). Sessions under
// ~/.claude/projects/<encoded>/ are deliberately left in place — they
// might still be referenced by `claude --resume` outside the
// orchestrator.
export async function deleteProject(name) {
  validateName(name);
  const full = path.join(projectsRoot(), name);
  try {
    await fs.rm(full, { recursive: true, force: true });
  } catch (e) {
    const err = new Error(`failed to delete project '${name}': ${e.message}`);
    err.statusCode = 500;
    throw err;
  }
  return { name, path: full };
}

export async function getProject(name) {
  validateName(name);
  const full = path.join(projectsRoot(), name);
  try {
    const stat = await fs.stat(full);
    if (!stat.isDirectory()) {
      const err = new Error(`'${name}' is not a directory`);
      err.statusCode = 404;
      throw err;
    }
    return { name, path: full };
  } catch (e) {
    if (e.code === 'ENOENT') {
      const err = new Error(`project '${name}' not found`);
      err.statusCode = 404;
      throw err;
    }
    throw e;
  }
}

async function readFirstPrompt(jsonlPath) {
  const fh = await fs.open(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === 'user' && obj.message) {
        const c = obj.message.content;
        if (typeof c === 'string') return c.slice(0, 200);
        if (Array.isArray(c)) {
          for (const block of c) {
            if (block?.type === 'text' && typeof block.text === 'string') return block.text.slice(0, 200);
          }
        }
      }
      if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') return obj.lastPrompt.slice(0, 200);
    }
    return null;
  } finally {
    await fh.close();
  }
}

export async function listSessionsForCwd(absCwd) {
  const encoded = encodeCwd(absCwd);
  const dir = path.join(claudeProjectsRoot(), encoded);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    let firstPrompt = null;
    try { firstPrompt = await readFirstPrompt(full); } catch { /* ignore */ }
    out.push({
      sessionId: name.replace(/\.jsonl$/, ''),
      firstPrompt,
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export async function listSessions(projectName) {
  const proj = await getProject(projectName);
  return listSessionsForCwd(proj.path);
}

// Remove the persisted session jsonl at the conventional path.
// Returns true on success, false if the file didn't exist (404 path
// from the route). Caller is responsible for killing any running
// instance attached to this sessionId first.
export async function deleteSessionForCwd(absCwd, sessionId) {
  const file = path.join(claudeProjectsRoot(), encodeCwd(absCwd), `${sessionId}.jsonl`);
  try {
    await fs.unlink(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

// Look up which project (and optionally which worktree) owns a given
// sessionId by probing the conventional `~/.claude/projects/<encoded-cwd>/
// <sid>.jsonl` path against every known project + worktree. Returns
// { project, worktreeName: string|null } on hit, null when nothing matches.
// `encodeCwd` is one-way (lossy: '_' and '/' both collapse to '-'), so
// we can't reverse-map a directory name back to a project — enumerating
// known paths and probing is the only correct approach.
export async function findSessionLocation(sessionId) {
  // Permissive validation: sessionIds are UUIDs in practice but we accept
  // anything that's safe to interpolate into a filename. The point is to
  // reject path-traversal payloads before they touch the filesystem.
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  // Lazy import to avoid the projects.js ↔ worktrees.js circular dep
  // worktrees.js already imports from projects.js (encodeCwd, etc.).
  const { listWorktrees } = await import('./worktrees.js');
  const projects = await listProjects();
  for (const proj of projects) {
    const file = path.join(claudeProjectsRoot(), encodeCwd(proj.path), `${sessionId}.jsonl`);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) return { project: proj.name, worktreeName: null };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    let wts = [];
    try { wts = await listWorktrees(proj.name); } catch { /* project may not be a git repo, skip */ }
    for (const wt of wts) {
      const wtFile = path.join(claudeProjectsRoot(), encodeCwd(wt.worktreePath), `${sessionId}.jsonl`);
      try {
        const stat = await fs.stat(wtFile);
        if (stat.isFile()) return { project: proj.name, worktreeName: wt.worktreeName };
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  return null;
}

// Lightweight session summary — used by /api/projects to show a count +
// "last active" stamp in the sidebar without paying the file-read cost
// of listSessionsForCwd (which extracts firstPrompt from every jsonl).
// Just readdir + stat, no opens.
export async function summarizeSessions(absCwd) {
  const dir = path.join(claudeProjectsRoot(), encodeCwd(absCwd));
  let entries;
  try { entries = await fs.readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return { count: 0, lastMtime: 0 }; throw e; }
  let count = 0;
  let lastMtime = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    let stat;
    try { stat = await fs.stat(path.join(dir, name)); } catch { continue; }
    if (!stat.isFile()) continue;
    count++;
    if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs;
  }
  return { count, lastMtime };
}
