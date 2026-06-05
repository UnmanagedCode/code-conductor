// Migration 0005: rename the durable worker-session marker sidecar from
// `conductor-sessions.json` to `conducted-sessions.json`.
//
// Background: the marker that flags sessions spawned via the MCP
// `spawn_instance` tool used to be called "conductor". That was a
// misnomer — those are the *worker* agents an orchestrator conducts (the
// "conducted" sessions); the orchestrator itself is the `.conduct`
// session. The marker (field, functions, sidecar file) was renamed
// conductor→conducted. This migration moves the persisted set so
// previously-marked sessions keep their badge across the rename.
//
// Scope: a single file in the central store, `<root>/.code-conductor/`.
// Idempotent: a no-op once the old file is gone. If a `conducted-
// sessions.json` already exists (server wrote one post-deploy before the
// migration ran), the two session sets are unioned so no marker is lost
// in either direction.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0005-rename-conducted-marker';

// Default projects root = parent dir of the repo (migrations/0005…mjs →
// ../../). Mirrors src/projects.js's DEFAULT_PROJECTS_ROOT; kept self-
// contained per the migrations conventions.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

async function pathExists(p) {
  try { await fs.lstat(p); return true; }
  catch { return false; }
}

// Read a `{ sessions: [sid,…] }` sidecar into an array of string sids.
// Returns [] for a missing/malformed file (mirrors loadAll in
// src/conductedSessions.js — best-effort, never throws on bad shape).
async function readSessions(file) {
  try {
    const obj = JSON.parse(await fs.readFile(file, 'utf8'));
    const arr = Array.isArray(obj?.sessions) ? obj.sessions : [];
    return arr.filter((s) => typeof s === 'string' && s);
  } catch {
    return [];
  }
}

async function writeSessions(file, sids) {
  const obj = { sessions: [...new Set(sids)].sort((a, b) => a.localeCompare(b)) };
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function run({ root, log = console.log } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const store = path.join(projectsRoot, '.code-conductor');
  const oldFile = path.join(store, 'conductor-sessions.json');
  const newFile = path.join(store, 'conducted-sessions.json');

  // Already-applied / never-existed fast path.
  if (!(await pathExists(oldFile))) return { applied: false };

  if (!(await pathExists(newFile))) {
    await fs.rename(oldFile, newFile);
    log(`  ✓ renamed ${oldFile} → ${newFile}`);
    return { applied: true, summary: { renamed: true } };
  }

  // Both exist — union the two sets, write the merged result to the new
  // file, then drop the old one. No marker lost in either direction.
  const merged = [...await readSessions(oldFile), ...await readSessions(newFile)];
  await writeSessions(newFile, merged);
  await fs.rm(oldFile, { force: true });
  const count = new Set(merged).size;
  log(`  ✓ merged ${oldFile} into ${newFile} (${count} session markers)`);
  return { applied: true, summary: { merged: count } };
}
