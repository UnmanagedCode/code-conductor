// The Add-project dialog swaps the remedy clause at the end of two adopt
// refusals for the one it offers (web/src/features/dialogs/adoptMessages.ts).
// Each override names the server's tail verbatim; if the server's sentence
// changes, messageFor falls back to the server's wording and the override
// silently never runs. So both refusals are built here by the real code — the
// sentence builder and a real refused cross-kind relocate — and the dialog's
// tails are checked against them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { REFUSAL_OVERRIDES, messageFor } from '../web/src/features/dialogs/adoptMessages.ts';

const tailFor = (code) => REFUSAL_OVERRIDES.find((o) => o.code === code)?.serverTail;

test('the overridden refusals still end with the exact tails the adopt dialog strips', async () => {
  // ── TRANSCRIPT_DIR_COLLISION, from the real sentence builder.
  const { transcriptCollisionReason } = await import('../src/systems/transcriptKey.ts');
  const candidate = { project: 'p', worktree: null, system: 'local', remoteId: null, cwd: '/srv/a' };
  const real = transcriptCollisionReason("project 'p'", candidate, { ...candidate, project: 'q', samePath: true });
  const transcriptTail = tailFor('TRANSCRIPT_DIR_COLLISION');
  assert.ok(real.endsWith(transcriptTail),
    `the dialog strips ${JSON.stringify(transcriptTail)} but the server now says ${JSON.stringify(real)}`);
  // What the user is shown for the real sentence, not merely that the tail is gone:
  // a remedy stripped and replaced with nothing would leave no next action.
  const shownTranscript = messageFor({ code: 'TRANSCRIPT_DIR_COLLISION', reason: real });
  assert.ok(!shownTranscript.includes('Pick another name'), 'the server remedy is gone from the real sentence');
  assert.match(shownTranscript, /Pick a different directory/, 'and the replacement is what stands in its place');
  assert.ok(shownTranscript.startsWith(real.slice(0, -transcriptTail.length)),
    'everything the server said before the remedy survives verbatim');

  // ── PROJECT_PLACEMENT_IN_USE, from a real refused relocate. It needs a
  // cross-kind move of a project whose record is stale and whose worktrees are
  // registered, so the fixture registers a reachable system and adopts there.
  const { freshProjectsRoot, rmrf } = await import('./helpers.mjs');
  const { bindRemoteSystem, seedRepo } = await import('./remoteSystem.mjs');
  const { adoptProject } = await import('../src/projects.ts');
  const { createWorktree } = await import('../src/worktrees.ts');
  const { disposeSystemHandles } = await import('../src/systems/registry.ts');

  const { home } = await freshProjectsRoot();
  try {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    await createWorktree('app', { name: 'feature' });
    await fs.rm(tree, { recursive: true, force: true });
    const moved = await seedRepo(path.join(remote.root, 'app-moved'));

    const refused = await adoptProject('app', moved, { system: remote.id, onStaleRecord: 'relocate' });
    assert.equal(refused.code, 'PROJECT_PLACEMENT_IN_USE', JSON.stringify(refused));
    const placementTail = tailFor('PROJECT_PLACEMENT_IN_USE');
    assert.ok(refused.reason.endsWith(placementTail),
      `the dialog strips ${JSON.stringify(placementTail)} but the server now says ${JSON.stringify(refused.reason)}`);
    const shown = messageFor(refused);
    assert.ok(!shown.includes('onStaleRecord'), 'the override actually fires on the real sentence');
    assert.match(shown, /choose Replace below/);
  } finally {
    disposeSystemHandles();
    await rmrf(home);
  }
});
