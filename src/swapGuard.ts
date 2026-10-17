// The check every web swap that a decision was made for runs between the
// finished build and the rename (SwapGuard, src/webBuild.ts). A build is made
// from the mutable working tree, and a merge lands in it whenever it lands, so
// what the build holds is only vouched for if the tree is still the one the
// decision was about. Three checks, each catching what the others miss:
//   (a) HEAD is still the decided-at commit — a merge, or any commit, since;
//   (b) the inputs hash now equals the build's stamp — the tree changed while
//       the build ran (an untracked file included);
//   (c) `git diff --quiet HEAD -- <cleanPaths>` — an uncommitted edit made
//       before the hash was taken, which (a) and (b) both read as consistent.

import { runGit } from './worktrees.ts';
import { localSystem } from './systems/registry.ts';
import { webSourceHash, type SwapGuard, type WebInputs } from './webBuild.ts';

export function sourcesUnmovedGuard(
  { root, inputs, head, cleanPaths }: { root: string; inputs: WebInputs; head: string; cleanPaths: string[] },
): SwapGuard {
  const git = (args: string[]) => runGit(localSystem(), root, args);
  return async (stamp) => {
    const now = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim();
    if (now !== head) return `HEAD moved from ${head.slice(0, 12)} to ${now.slice(0, 12) || 'nothing'}`;
    if (webSourceHash(inputs) !== stamp) return 'the build inputs changed while it was building';
    if (cleanPaths.length > 0) {
      const diff = await git(['diff', '--quiet', 'HEAD', '--', ...cleanPaths]);
      if (diff.code === 1) return `uncommitted changes under ${cleanPaths.join(', ')}`;
      if (diff.code !== 0) return `could not tell whether ${cleanPaths.join(', ')} are clean (git diff exited ${diff.code})`;
    }
    return null;
  };
}
