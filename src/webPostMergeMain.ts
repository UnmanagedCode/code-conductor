// Entry for `.code-conductor/post-worktree-merge.sh`: node src/webPostMergeMain.ts <pre> <post>, cwd = the merge target.
import { bootCommitFromEnv, runWebPostMerge } from './webPostMerge.ts';
await runWebPostMerge({ root: process.cwd(), pre: process.argv[2], post: process.argv[3], boot: bootCommitFromEnv(process.env) });
