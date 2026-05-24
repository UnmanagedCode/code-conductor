// Migration 0002: rename the project-grouping concept "group" to
// "workspace".
//
// Before: per-project `project.json` files held `{"group": "<name>"}`;
//         the set of groups was implicit (derived from these values).
// After:  per-project `project.json` files hold `{"workspace": "<name>"}`,
//         and the union of distinct names is mirrored to a registry at
//         `<root>/.code-conductor/workspaces.json` so empty workspaces
//         can persist independently of membership.
//
// Frozen artifact — do not edit. Uses Node built-ins only so it stays
// robust to future src/ refactors.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const name = '0002-rename-group-to-workspace';

const DOTDIR = '.code-conductor';

async function pathExists(p) {
  try { await fs.access(p); return true; }
  catch { return false; }
}

async function readJsonSafe(p) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  if (!root) throw new Error('migration 0002: root is required');
  const projectsDir = path.join(root, DOTDIR, 'projects');
  const registryFile = path.join(root, DOTDIR, 'workspaces.json');

  // Probe: nothing to do if there's no central store yet.
  if (!(await pathExists(projectsDir))) return { applied: false };

  const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const projectNames = projectEntries.filter(e => e.isDirectory()).map(e => e.name);

  // First pass: detect whether any project.json still carries a `group`
  // key. If none do AND the registry already exists, we're already
  // applied — fast no-op.
  let pendingFields = 0;
  const seenWorkspaces = new Set();
  for (const name of projectNames) {
    const file = path.join(projectsDir, name, 'project.json');
    const obj = await readJsonSafe(file);
    if (!obj || typeof obj !== 'object') continue;
    if ('group' in obj) pendingFields++;
    const candidate = (typeof obj.workspace === 'string' && obj.workspace.trim())
      || (typeof obj.group === 'string' && obj.group.trim())
      || null;
    if (candidate) seenWorkspaces.add(candidate);
  }
  const registryExists = await pathExists(registryFile);
  if (pendingFields === 0 && registryExists) return { applied: false };

  // Real work: rewrite each project.json that has a `group` field, and
  // seed the registry from the union of values observed.
  let fieldsMigrated = 0;
  for (const name of projectNames) {
    const file = path.join(projectsDir, name, 'project.json');
    const obj = await readJsonSafe(file);
    if (!obj || typeof obj !== 'object') continue;
    if (!('group' in obj)) continue;
    const next = { ...obj };
    // Prefer an already-present workspace field; otherwise lift `group`.
    if (!('workspace' in next) || typeof next.workspace !== 'string' || !next.workspace.trim()) {
      if (typeof next.group === 'string' && next.group.trim()) {
        next.workspace = next.group.trim();
      }
    }
    delete next.group;
    // Drop the file entirely if no meaningful fields remain (mirrors
    // src/projects.js writeProjectMeta's empty-file deletion behavior).
    const meaningful = Object.keys(next).filter(k => next[k] !== null && next[k] !== undefined && next[k] !== '');
    if (meaningful.length === 0) {
      try { await fs.unlink(file); } catch { /* ignore */ }
    } else {
      await writeJsonAtomic(file, next);
    }
    fieldsMigrated++;
    log(`  migrated ${name}/project.json: group → workspace`);
  }

  // Seed the registry from observed values if it doesn't already exist.
  // If it does exist, leave it alone — we may be running after a
  // previous partial migration that already wrote it.
  let registrySeeded = false;
  if (!registryExists && seenWorkspaces.size > 0) {
    const sorted = [...seenWorkspaces].sort((a, b) => a.localeCompare(b));
    await writeJsonAtomic(registryFile, { workspaces: sorted });
    registrySeeded = true;
    log(`  seeded ${registryFile} with ${sorted.length} workspace(s)`);
  }

  return {
    applied: fieldsMigrated > 0 || registrySeeded,
    summary: { fieldsMigrated, registrySeeded, workspacesSeeded: seenWorkspaces.size },
  };
}
