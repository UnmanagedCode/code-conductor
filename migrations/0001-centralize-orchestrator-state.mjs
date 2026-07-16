// Migration 0001: centralize orchestrator state.
//
// Before: each project / worktree carried its own `.code-conductor/`
// dotfolder holding project.json, worktree.json, attachments/, debug/.
// After:  every artifact lives under a single central store at
//         `<root>/.code-conductor/projects/<project>/...`.
//
// Frozen artifact — do not edit. Uses Node built-ins only so it stays
// robust to future src/ refactors.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = '0001-centralize-orchestrator-state';

const DOTDIR = '.code-conductor';
const STORE_PROJECTS = path.join(DOTDIR, 'projects');

async function pathExists(p) {
  try { await fs.access(p); return true; }
  catch { return false; }
}

async function isDirectory(p) {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch { return false; }
}

async function readJsonSafe(p) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

// Artifacts this migration actually relocates. A `.code-conductor/`
// dotfolder is only a migration candidate if it holds one of these — a
// folder carrying only non-migratable residents (e.g. a live in-tree
// `post-worktree-create.sh` hook) is already-applied and must not keep
// re-triggering the migration every boot.
const MIGRATABLE = ['project.json', 'worktree.json', 'attachments', 'debug'];
async function hasMigratableArtifact(dotdir) {
  for (const name of MIGRATABLE) {
    if (await pathExists(path.join(dotdir, name))) return true;
  }
  return false;
}

// Move src → dst. Refuses to clobber: if dst already exists (file, or
// non-empty directory) we leave src in place and return 'skipped'. An
// empty destination directory is folded into. Returns 'moved',
// 'absent', or 'skipped'.
async function safeMove(src, dst, log) {
  if (!(await pathExists(src))) return 'absent';
  let dstStat = null;
  try { dstStat = await fs.stat(dst); } catch { /* dst absent */ }
  if (dstStat) {
    if (dstStat.isDirectory()) {
      const entries = await fs.readdir(dst);
      if (entries.length > 0) {
        log(`  ⚠ skipping ${src} → ${dst} (destination already non-empty)`);
        return 'skipped';
      }
      try { await fs.rmdir(dst); } catch { /* fall through */ }
    } else {
      // Destination is a file — never overwrite.
      log(`  ⚠ skipping ${src} → ${dst} (destination file already exists)`);
      return 'skipped';
    }
  }
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
  return 'moved';
}

// Best-effort: strip `.code-conductor/` and `/.code-conductor/` lines
// from a text file (handles both .gitignore and .git/info/exclude).
async function stripDotdirLine(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  const out = text
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return t !== `${DOTDIR}/` && t !== `/${DOTDIR}/`;
    })
    .join('\n');
  if (out === text) return false;
  await fs.writeFile(file, out, 'utf8');
  return true;
}

// Walk a worktree's .git pointer (`.git` is a file in a linked worktree
// pointing at the real gitdir) and return the absolute path to its
// per-worktree info/exclude.
async function worktreeExcludeFile(worktreePath) {
  const gitFile = path.join(worktreePath, '.git');
  let raw;
  try { raw = await fs.readFile(gitFile, 'utf8'); }
  catch { return null; }
  const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const gitdir = path.isAbsolute(m[1]) ? m[1] : path.resolve(worktreePath, m[1]);
  return path.join(gitdir, 'info', 'exclude');
}

export async function run({ root, log = console.log } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? path.join(os.homedir(), 'project');
  const storeRoot = path.join(projectsRoot, DOTDIR);
  const storeProjects = path.join(projectsRoot, STORE_PROJECTS);

  // Already-applied probe: walk top-level entries, return early if
  // nothing carries a legacy `.code-conductor/` dotfolder.
  let topEntries;
  try { topEntries = await fs.readdir(projectsRoot, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return { applied: false }; throw e; }

  const candidates = [];
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue; // central store + other dotfolders
    const dotdir = path.join(projectsRoot, e.name, DOTDIR);
    if (await pathExists(dotdir) && await hasMigratableArtifact(dotdir)) {
      candidates.push({ dir: e.name, dotdir });
    }
  }
  if (candidates.length === 0) return { applied: false };

  log(`migration ${name}: ${candidates.length} legacy dotfolder(s) detected — migrating...`);
  await fs.mkdir(storeProjects, { recursive: true });

  let projectsMigrated = 0;
  let worktreesMigrated = 0;
  let skipped = 0;
  const errors = [];

  for (const c of candidates) {
    const fullDir = path.join(projectsRoot, c.dir);
    const meta = await readJsonSafe(path.join(c.dotdir, 'worktree.json'));
    const isWorktree = !!meta && typeof meta.parentProject === 'string';

    try {
      if (isWorktree) {
        const parent = meta.parentProject;
        const wtName = meta.worktreeName || c.dir;
        const destDir = path.join(storeProjects, parent, 'worktrees', wtName);
        await fs.mkdir(destDir, { recursive: true });

        const r1 = await safeMove(path.join(c.dotdir, 'worktree.json'), path.join(destDir, 'worktree.json'), log);
        const r2 = await safeMove(path.join(c.dotdir, 'attachments'), path.join(destDir, 'attachments'), log);
        const r3 = await safeMove(path.join(c.dotdir, 'debug'),       path.join(destDir, 'debug'),       log);
        if ([r1, r2, r3].includes('skipped')) skipped++;
        else worktreesMigrated++;

        // Best-effort: strip the dotdir line from the worktree's
        // per-worktree info/exclude file.
        const excludeFile = await worktreeExcludeFile(fullDir);
        if (excludeFile) {
          try { await stripDotdirLine(excludeFile); } catch { /* ignore */ }
        }
      } else {
        const destDir = path.join(storeProjects, c.dir);
        await fs.mkdir(destDir, { recursive: true });
        const r1 = await safeMove(path.join(c.dotdir, 'project.json'),  path.join(destDir, 'project.json'),  log);
        const r2 = await safeMove(path.join(c.dotdir, 'attachments'),   path.join(destDir, 'attachments'),   log);
        const r3 = await safeMove(path.join(c.dotdir, 'debug'),         path.join(destDir, 'debug'),         log);
        if ([r1, r2, r3].includes('skipped')) skipped++;
        else projectsMigrated++;

        // Best-effort: strip the dotdir line from <project>/.gitignore.
        try { await stripDotdirLine(path.join(fullDir, '.gitignore')); }
        catch { /* ignore */ }
      }

      // Clean up the now-empty (or near-empty) legacy dotdir.
      try {
        const remaining = await fs.readdir(c.dotdir);
        if (remaining.length === 0) {
          await fs.rmdir(c.dotdir);
        } else {
          log(`  ⚠ ${c.dotdir} still contains: ${remaining.join(', ')} — left in place`);
        }
      } catch { /* ignore */ }
    } catch (e) {
      errors.push({ dir: c.dir, message: e.message });
      log(`  ✗ failed migrating ${c.dir}: ${e.message}`);
    }
  }

  // If nothing actually moved but candidates existed (all skipped), still
  // mark as applied so the summary is visible.
  const did = projectsMigrated + worktreesMigrated + skipped + errors.length > 0;
  if (!did) return { applied: false };

  // Make sure the store root exists even if every candidate was a
  // worktree — `storeProjects` already covers it via mkdir above. Touch
  // the dir so subsequent boots see "store exists, no legacy dotdirs".
  await fs.mkdir(storeRoot, { recursive: true });

  return {
    applied: true,
    summary: { projectsMigrated, worktreesMigrated, skipped, errors: errors.length },
  };
}
