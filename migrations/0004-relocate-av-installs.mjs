// Migration 0004: relocate the voice-dictation (whisper.cpp) and TTS (piper)
// installs from the old default at $HOME/.code-conductor into the central
// orchestrator store at <root>/.code-conductor.
//
// Background: whisper/piper used to default their INSTALL_ROOT to
// $HOME/.code-conductor, a separate dir from the orchestrator store
// (<root>/.code-conductor, which holds projects/, settings.json,
// workspaces.json). That produced two .code-conductor folders and, because
// $HOME/.code-conductor sits outside the workspace, it was unrelated to
// PROJECTS_ROOT. The default now resolves to the central store, so this
// migration moves any pre-existing install to match — sparing a ~400 MB
// rebuild/redownload.
//
// Scope: only the old *default* location is migrated. If INSTALL_ROOT is set
// the user pinned their own location (honoured identically by old and new
// code), so there is nothing to relocate and this is a no-op.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0004-relocate-av-installs';

// The two asset dirs whisper/piper install under their INSTALL_ROOT.
const ASSET_DIRS = ['whisper.cpp', 'piper'];

// Default projects root = parent dir of the repo (migrations/0004…mjs →
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

// rename, falling back to copy+remove when src and dst straddle filesystems.
async function moveDir(src, dst) {
  try {
    await fs.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.cp(src, dst, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

export async function run({ root, log = console.log } = {}) {
  // A pinned INSTALL_ROOT means the install never lived at the old default —
  // and the new code resolves to the same pinned path — so nothing to move.
  if (process.env.INSTALL_ROOT) return { applied: false };

  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const home = process.env.HOME || (await import('node:os')).homedir();
  const oldRoot = path.join(home, '.code-conductor');
  const newRoot = path.join(projectsRoot, '.code-conductor');

  // If the old default and the new store are the same dir (e.g. PROJECTS_ROOT
  // == $HOME), there is nothing to relocate.
  if (path.resolve(oldRoot) === path.resolve(newRoot)) return { applied: false };

  // Fast already-applied probe: nothing of ours at the old location.
  const present = [];
  for (const d of ASSET_DIRS) {
    if (await pathExists(path.join(oldRoot, d))) present.push(d);
  }
  if (present.length === 0) return { applied: false };

  await fs.mkdir(newRoot, { recursive: true });
  // Stamp for any collision backups; replace ':'/'.' so it's a safe dirname.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summary = {};

  for (const d of present) {
    const src = path.join(oldRoot, d);
    const dst = path.join(newRoot, d);
    if (await pathExists(dst)) {
      // A newer install already lives at the destination — it's authoritative.
      // Preserve the stale old copy in a backup rather than clobbering either.
      const backupRoot = path.join(newRoot, `migrated-backup-${stamp}`);
      await fs.mkdir(backupRoot, { recursive: true });
      await moveDir(src, path.join(backupRoot, d));
      summary[d] = 'backed-up (destination already existed)';
      log(`  ⚠ ${dst} already exists — moved stale ${src} to ${backupRoot}/${d}`);
    } else {
      await moveDir(src, dst);
      summary[d] = 'moved';
      log(`  ✓ relocated ${src} → ${dst}`);
    }
  }

  // Tidy up the old dir if it's now empty (ignore if it still holds anything).
  try { await fs.rmdir(oldRoot); summary.oldRootRemoved = true; }
  catch { summary.oldRootRemoved = false; }

  return { applied: true, summary };
}
