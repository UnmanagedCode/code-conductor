import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Directories owned by the orchestrator's worktree feature carry one of
// these marker paths (see src/worktrees.js). New worktrees use the
// `.claude-orch-app/worktree.json` dotfolder layout; older ones still
// have the single `.claude-orch-worktree.json` file at the root. Top-
// level project listing filters them out so they aren't presented as
// standalone projects — they appear as a child node under the parent.
const WORKTREE_MARKERS = ['.claude-orch-app/worktree.json', '.claude-orch-worktree.json'];

async function isWorktreeMarkerPresent(dir) {
  for (const marker of WORKTREE_MARKERS) {
    try {
      await fs.access(path.join(dir, marker));
      return true;
    } catch { /* try next */ }
  }
  return false;
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
    out.push({ name: e.name, path: full });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
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
