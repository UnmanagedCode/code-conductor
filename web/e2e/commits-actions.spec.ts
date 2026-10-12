import { test } from './harness/fixtures.ts';
import { commitsActionsFlow } from './commits-actions.shared.ts';

// Its own cc: the flow locks worktrees and syncs one.
test.use({ ccOptions: { server: 'commits-actions' } });

test('the commit history names Sync, Merge and Lock, Lock round-trips and gates Merge per worktree, an action in flight disables all three, and Merge asks first', commitsActionsFlow);
