// Migration 0003: switch .conduct/ from an external @-import to an
// in-project CONDUCT.md symlink.
//
// Background: Claude Code gates @-import paths that resolve outside the
// project root behind an "external includes approved" dialog that never
// fires in headless / `-p` mode. Conductor sessions are spawned that
// way, so the old seed (`@<rel-or-abs path>/CONDUCT.md` pointing into
// the repo) silently no-op'd — conductor sessions ran with no role
// definition loaded.
//
// This migration:
//   1. Ensures `<root>/.conduct/CONDUCT.md` exists as a symlink to the
//      repo's CONDUCT.md (skipped if a real file is already there).
//   2. If `<root>/.conduct/CLAUDE.md` still contains a broken external
//      @-import pointing at CONDUCT.md, rewrites *just that line* to
//      `@CONDUCT.md`. Every other line (e.g. user-customised shorthand)
//      is preserved verbatim.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const name = '0003-conduct-md-symlink';

const CONDUCT_DIR = '.conduct';

// Resolve the repo's CONDUCT.md path from this migration's location
// (migrations/0003-…mjs → ../CONDUCT.md). Mirrors how src/conduct.js
// resolves it, but kept self-contained per the migrations conventions.
const REPO_CONDUCT_MD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'CONDUCT.md',
);

async function pathExists(p) {
  try { await fs.access(p); return true; }
  catch { return false; }
}

async function ensureSymlink(symlinkPath, targetRel, log) {
  let entryStat = null;
  try { entryStat = await fs.lstat(symlinkPath); }
  catch { /* absent */ }
  if (entryStat) {
    if (entryStat.isSymbolicLink()) {
      // Already a symlink — leave alone even if target differs, to
      // respect any user override.
      return 'already-symlink';
    }
    // Real file / directory — never clobber.
    log(`  ⚠ ${symlinkPath} exists and is not a symlink — leaving alone`);
    return 'skipped';
  }
  await fs.symlink(targetRel, symlinkPath);
  return 'created';
}

// Heuristic: a line is a broken external CONDUCT.md import if it starts
// with '@', references CONDUCT.md, and the resolved path falls outside
// the .conduct/ dir. `@CONDUCT.md` itself is in-project and stays.
function isBrokenConductImport(line, conductDir) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('@')) return false;
  const target = trimmed.slice(1).trim();
  if (!target.endsWith('CONDUCT.md')) return false;
  if (target === 'CONDUCT.md') return false; // already in-project
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(conductDir, target);
  const rel = path.relative(conductDir, resolved);
  // Escapes .conduct/ if the relative path starts with .. or is absolute.
  return rel.startsWith('..') || path.isAbsolute(rel);
}

async function fixClaudeMd(claudeMdPath, conductDir, log) {
  let text;
  try { text = await fs.readFile(claudeMdPath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return 'absent';
    throw e;
  }

  const lines = text.split('\n');
  let mutated = false;
  const out = lines.map(line => {
    if (isBrokenConductImport(line, conductDir)) {
      mutated = true;
      return '@CONDUCT.md';
    }
    return line;
  });
  if (!mutated) return 'unchanged';

  await fs.writeFile(claudeMdPath, out.join('\n'), 'utf8');
  log(`  ✓ rewrote broken CONDUCT.md @-import in ${claudeMdPath}`);
  return 'rewritten';
}

export async function run({ root, log = console.log } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? path.join(os.homedir(), 'project');
  const conductDir = path.join(projectsRoot, CONDUCT_DIR);

  if (!(await pathExists(conductDir))) {
    return { applied: false };
  }

  // Already-applied probe: symlink correct AND no broken import in
  // CLAUDE.md → fast no-op.
  const symlinkPath = path.join(conductDir, 'CONDUCT.md');
  const claudeMdPath = path.join(conductDir, 'CLAUDE.md');

  let symlinkAlreadyOk = false;
  try {
    const st = await fs.lstat(symlinkPath);
    symlinkAlreadyOk = st.isSymbolicLink();
  } catch { /* absent */ }

  let claudeMdNeedsFix = false;
  if (await pathExists(claudeMdPath)) {
    const text = await fs.readFile(claudeMdPath, 'utf8');
    claudeMdNeedsFix = text.split('\n').some(l => isBrokenConductImport(l, conductDir));
  }

  if (symlinkAlreadyOk && !claudeMdNeedsFix) {
    return { applied: false };
  }

  const targetRel = path.relative(conductDir, REPO_CONDUCT_MD);
  const symlinkResult = await ensureSymlink(symlinkPath, targetRel, log);
  const claudeMdResult = await fixClaudeMd(claudeMdPath, conductDir, log);

  return {
    applied: true,
    summary: { symlink: symlinkResult, claudeMd: claudeMdResult },
  };
}
