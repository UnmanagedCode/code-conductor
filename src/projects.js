import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function projectsRoot() {
  return process.env.PROJECTS_ROOT ?? path.join(os.homedir(), 'project');
}

export function claudeProjectsRoot() {
  return process.env.CLAUDE_PROJECTS_ROOT ?? path.join(os.homedir(), '.claude', 'projects');
}

export function encodeCwd(abs) {
  // Mirror Claude Code's own encoding: every char that isn't alphanumeric,
  // hyphen, or underscore becomes `-`. This is critical for finding the
  // session jsonls — on this device every project path contains
  // `com.termux`, and previously we only replaced `/`, so the orchestrator
  // looked at `…com.termux…` while real claude wrote to `…com-termux…`,
  // silently returning empty history on resume.
  return abs.replace(/[^A-Za-z0-9_-]/g, '-');
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
    out.push({ name: e.name, path: path.join(root, e.name) });
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

export async function listSessions(projectName) {
  const proj = await getProject(projectName);
  const encoded = encodeCwd(proj.path);
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
