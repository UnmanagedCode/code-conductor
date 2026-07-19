// Migration 0018: the ollama session-backends sidecar now carries each session's
// tagged launch model, not just a membership bit.
//
// Before: {sessions:[sid, …]}            (set form — 0017's output)
// After:  {sessions:{sid: model|null}}   (map form; tag unknown for pre-existing
//                                          sessions → null)
//
// The tag was never persisted for these legacy sessions (the CLI's jsonl records
// the model bare), so their model is unknowable here — seed null. They resume
// exactly as before (jsonl fallback) and self-heal the first time they relaunch
// with a real tag (Instance.spawn re-marks the store). Idempotent: a no-op once
// `sessions` is already an object (or the file is absent).
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0018-session-backends-carry-model';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}
async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const sidecarFile = path.join(projectsRoot, '.code-conductor', 'session-backends.json');

  const sidecar = await readJsonSafe(sidecarFile);
  if (!sidecar || typeof sidecar !== 'object' || !Array.isArray(sidecar.sessions)) {
    return { applied: false };
  }

  const sessions = {};
  for (const sid of sidecar.sessions) {
    if (typeof sid === 'string' && sid) sessions[sid] = null;
  }
  const sorted = {};
  for (const sid of Object.keys(sessions).sort((a, b) => a.localeCompare(b))) sorted[sid] = null;

  await writeJsonAtomic(sidecarFile, { sessions: sorted });
  const count = Object.keys(sorted).length;
  log(`  ✓ reshaped session-backends sidecar set → map (${count} session${count === 1 ? '' : 's'}, tag=null)`);
  return { applied: true, summary: { sessions: count } };
}
