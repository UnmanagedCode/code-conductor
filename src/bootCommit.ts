// The commit the running server booted from, recorded in cc's own checkout so
// a post-merge hook can tell whether a merge changed code the server is
// running (src/webPostMerge.ts).
//
// The record is `cc-boot-commit` in the checkout's own git dir
// (`git rev-parse --git-path cc-boot-commit`): per checkout, since a worktree
// has its own git dir, and outside the working tree, so it never dirties it.
// A hook in the same checkout finds it with the same command.
//
// `sha` is null, with a `reason`, whenever the server cannot vouch that what
// it runs is HEAD: an unborn or unreadable HEAD, or tracked changes outside
// web/ at boot. Changes only under web/ still record HEAD — the backend
// matches it. Two servers on one checkout: the last to boot wins.

import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './worktrees.ts';
import { localSystem } from './systems/registry.ts';
import { isProcessAlive } from './storeLock.ts';

const BOOT_COMMIT_FILE = 'cc-boot-commit';

export type BootCommitRecord = { sha: string | null; reason?: string; pid: number; bootedAt: string };
export type BootCommit = { sha: string } | { unknown: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where `root`'s checkout keeps the record, or null when `root` is not a git checkout. */
export async function bootCommitPath(root: string): Promise<string | null> {
  const r = await runGit(localSystem(), root, ['rev-parse', '--git-path', BOOT_COMMIT_FILE]);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  return path.resolve(root, r.stdout.trim());
}

async function measure(root: string): Promise<{ sha: string | null; reason?: string }> {
  const head = await runGit(localSystem(), root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code !== 0 || !head.stdout.trim()) return { sha: null, reason: 'HEAD is unborn or unreadable' };
  const status = await runGit(localSystem(), root, ['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude)web']);
  if (status.code !== 0) {
    return { sha: null, reason: `could not read the working tree (git status exited ${status.code})` };
  }
  const dirty = status.stdout.split('\n').filter(Boolean);
  if (dirty.length > 0) {
    const named = dirty.slice(0, 5).map(l => l.slice(3)).join(', ') + (dirty.length > 5 ? ', …' : '');
    return { sha: null, reason: `tracked changes outside web/ at boot (${named})` };
  }
  return { sha: head.stdout.trim() };
}

/**
 * Write this process's boot record for the checkout at `repoRoot`, atomically.
 * Never throws: boot must not fail on it. Writes nothing outside a git
 * checkout. Returns what it wrote, or null.
 */
export async function recordBootCommit(
  { repoRoot, log = console }: { repoRoot: string; log?: Pick<Console, 'log' | 'warn'> },
): Promise<BootCommitRecord | null> {
  try {
    const file = await bootCommitPath(repoRoot);
    if (!file) {
      log.log(`boot commit: ${repoRoot} is not a git checkout — not recorded`);
      return null;
    }
    const record: BootCommitRecord = { ...(await measure(repoRoot)), pid: process.pid, bootedAt: new Date().toISOString() };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record) + '\n');
    fs.renameSync(tmp, file);
    return record;
  } catch (e) {
    log.warn(`boot commit: could not record it: ${errText(e)}`);
    return null;
  }
}

/**
 * What the server running from `root`'s checkout booted from. Anything that
 * cannot vouch for a commit reads as `unknown`, with the case named: no
 * record, an unparseable one, a null sha, or a server no longer running.
 */
export async function readBootCommit(root: string): Promise<BootCommit> {
  const file = await bootCommitPath(root);
  if (!file) return { unknown: 'not a git checkout' };
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { unknown: `no boot record at ${file}` }; }
  let rec: Partial<BootCommitRecord>;
  try { rec = JSON.parse(text); }
  catch { return { unknown: `the boot record at ${file} is unparseable` }; }
  if (typeof rec?.pid !== 'number' || !isProcessAlive(rec.pid)) {
    return { unknown: `the server that wrote the boot record (pid ${rec?.pid}) is no longer running` };
  }
  if (typeof rec.sha !== 'string' || !rec.sha) {
    return { unknown: `the server could not tell what it booted from: ${rec.reason ?? 'no reason recorded'}` };
  }
  return { sha: rec.sha };
}
