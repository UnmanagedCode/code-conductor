// Whether the running server is behind its own checkout's HEAD: the one
// comparison of the boot commit (src/bootCommit.ts) with HEAD, read when
// `GET /api/settings/self-update` is asked, never on a timer.
//
// Only a change that reaches code the server loads asks for a restart
// (`needed`); the per-path test is serverMayLoad (src/serverImports.ts), the
// post-merge hook's own, over the BOOT commit's import graph. A HEAD that moved
// without touching it is `live`, and the server never restarts itself.
// Uncommitted edits made after boot are not counted: the state is commit-based.
//
// Memoised per HEAD (one `git rev-parse` per call; the diff and its
// classification only when HEAD changed) and the boot graph's walk once.
// Never throws: a failed read is `unknown`.

import { runGit } from './worktrees.ts';
import { localSystem } from './systems/registry.ts';
import { serverImportsAt, serverMayLoad, type ServerImports } from './serverImports.ts';
import type { BootCommit } from './bootCommit.ts';
import type { ServerRestartState } from '../shared/wireRows.ts';
import { errMsg } from '../shared/basics.ts';

export function restartStatusFor({ checkoutRoot, boot }: { checkoutRoot: string; boot: BootCommit }): () => Promise<ServerRestartState> {
  const git = (args: string[]) => runGit(localSystem(), checkoutRoot, args);
  let bootImports: Promise<ServerImports> | undefined;
  const importsAtBoot = (sha: string): Promise<ServerImports> => {
    if (!bootImports) {
      const walk = serverImportsAt(checkoutRoot, sha);
      bootImports = walk;
      // A rejected walk is not cached: the next call tries again.
      walk.catch(() => { if (bootImports === walk) bootImports = undefined; });
    }
    return bootImports;
  };

  async function classify(bootSha: string, head: string): Promise<ServerRestartState> {
    // Any two trees' diff lists every path whose running copy differs, so no
    // ancestry is required. --no-renames: a rename lists both sides.
    const diff = await git(['diff', '--no-renames', '--name-only', bootSha, head]);
    if (diff.code !== 0) {
      return { state: 'needed', boot: bootSha, head, reason: `the changes since the server booted could not be listed: ${diff.stderr.trim()}` };
    }
    const changed = diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const imports = await importsAtBoot(bootSha);
    for (const p of changed) {
      const reason = serverMayLoad(p, imports);
      if (reason !== null) return { state: 'needed', boot: bootSha, head, reason };
    }
    return { state: 'live', boot: bootSha, head };
  }

  let memo: { head: string; state: Promise<ServerRestartState> } | undefined;
  return async () => {
    if (!('sha' in boot)) return { state: 'unknown', reason: boot.unknown };
    try {
      const rev = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
      const head = rev.stdout.trim();
      if (rev.code !== 0 || !head) return { state: 'unknown', reason: 'HEAD is unborn or unreadable' };
      if (head === boot.sha) return { state: 'current', boot: boot.sha };
      if (memo?.head !== head) memo = { head, state: classify(boot.sha, head) };
      const mine = memo;
      try { return await mine.state; } catch (e) { if (memo === mine) memo = undefined; throw e; }
    } catch (e) {
      return { state: 'unknown', reason: `could not read the checkout: ${errMsg(e)}` };
    }
  };
}
