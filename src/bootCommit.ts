// The commit the running server booted from, captured in memory at boot and
// handed to a post-merge hook only by the server itself — so the commit a hook
// sees is always the serving process's, never a record another process left.
//
// The capture is unknown, with a reason, whenever the server cannot vouch that
// what it runs is HEAD: not a git checkout, an unborn or unreadable HEAD, or
// tracked changes outside web/ at boot. Changes only under web/ still capture
// HEAD — the backend matches it.
//
// What reaches a merge hook (bootCommitHookVars): for a merge into the
// server's OWN checkout, `CC_SERVER_BOOT_SHA` when the boot commit is known and
// no web build of the server's own is running, else `CC_SERVER_BOOT_UNKNOWN`
// naming why. Any other target gets neither.

import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './worktrees.ts';
import { localSystem } from './systems/registry.ts';
import { sourcesUnmovedGuard } from './swapGuard.ts';
import { inputPaths, type SwapGuard, type WebInputs } from './webBuild.ts';

// An unknown boot commit still carries `head` when HEAD was readable: the boot
// build's guard measures against it (bootSwapGuard).
export type BootCommit = { sha: string } | { unknown: string; head?: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the checkout at `root` would run as now. Never throws: boot must not fail on it. */
export async function measureBootCommit(root: string): Promise<BootCommit> {
  try {
    const git = (args: string[]) => runGit(localSystem(), root, args);
    if ((await git(['rev-parse', '--git-dir'])).code !== 0) return { unknown: `${root} is not a git checkout` };
    const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.code !== 0 || !head.stdout.trim()) return { unknown: 'HEAD is unborn or unreadable' };
    const status = await git(['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude)web']);
    const sha = head.stdout.trim();
    if (status.code !== 0) return { unknown: `could not read the working tree (git status exited ${status.code})`, head: sha };
    const dirty = status.stdout.split('\n').filter(Boolean);
    if (dirty.length > 0) {
      const named = dirty.slice(0, 5).map(l => l.slice(3)).join(', ') + (dirty.length > 5 ? ', …' : '');
      return { unknown: `tracked changes outside web/ at boot (${named})`, head: sha };
    }
    return { sha };
  } catch (e) {
    return { unknown: `could not read the checkout: ${errText(e)}` };
  }
}

/**
 * The guard the boot build asks before it swaps (ensureWebBuild), over the
 * same `inputs` that build hashes: HEAD still the one captured at boot, the
 * hash still the build's stamp, and — for a known boot commit — the inputs
 * outside web/ still clean, the capture's own rule, which lets web/ be dirty
 * at boot. An unknown boot commit was dirty by definition, so it skips that
 * last check; one with no readable HEAD has nothing to measure against and
 * gets no guard.
 */
export function bootSwapGuard(checkoutRoot: string, boot: BootCommit, inputs: WebInputs): SwapGuard | undefined {
  if ('sha' in boot) {
    const cleanPaths = inputPaths(inputs).filter((p) => p !== 'web' && !p.startsWith('web/'));
    return sourcesUnmovedGuard({ root: checkoutRoot, inputs, head: boot.sha, cleanPaths });
  }
  if (!boot.head) return undefined;
  return sourcesUnmovedGuard({ root: checkoutRoot, inputs, head: boot.head, cleanPaths: [] });
}

const realpathOr = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * The merge-hook env vars for a merge into `targetPath`, given the server's
 * checkout, its boot commit and whether its own web build is running. Read
 * when the hook runs, so a build that starts or ends meanwhile counts.
 */
export function bootCommitHookVars(
  { checkoutRoot, boot, webBuildRunning }: { checkoutRoot: string; boot: BootCommit; webBuildRunning: () => boolean },
): (targetPath: string) => Record<string, string> {
  const root = realpathOr(checkoutRoot);
  return (targetPath): Record<string, string> => {
    if (realpathOr(targetPath) !== root) return {};
    if (!('sha' in boot)) return { CC_SERVER_BOOT_UNKNOWN: boot.unknown };
    if (webBuildRunning()) return { CC_SERVER_BOOT_UNKNOWN: 'the server\'s own web build is running' };
    return { CC_SERVER_BOOT_SHA: boot.sha };
  };
}
