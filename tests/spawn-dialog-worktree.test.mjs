// The New Session dialog's "Run in isolated git worktree" checkbox, driven
// through the real public/spawnDialog.js with happy-dom.
//
// The load-bearing claim: the dialog pre-empts a spawn that the server would
// refuse. A project is one of THREE states — not a repo, a repo with an unborn
// HEAD (`git init` with no commit — what create_project leaves), or a normal
// repo — and only the third can take a worktree. The first two disable the box
// and say why in the hint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick, closeWithSpawn } from './spawnDialogHarness.mjs';

const EFFORT = { fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' };
const open = async (project, opts) => {
  const s = await setup(EFFORT, { projects: [project] });
  await s.handles.openSpawnDialog(project.name, opts);
  await tick();
  return s;
};

test('a normal repo leaves the worktree box enabled with the branched-off-HEAD hint', async () => {
  const { dom } = await open({ name: 'p', isGitRepo: true });
  assert.equal(dom.sdWorktree.disabled, false);
  assert.equal(dom.sdWorktreeHint.textContent,
    'creates a sibling worktree under ~/project/, branched off current HEAD');
});

test('a non-git project disables the box with the git-init hint', async () => {
  const { dom } = await open({ name: 'p', isGitRepo: false });
  assert.equal(dom.sdWorktree.disabled, true);
  assert.equal(dom.sdWorktree.checked, false);
  assert.equal(dom.sdWorktreeHint.textContent,
    'project is not a git repo — `git init` first to use worktrees');
});

test('an unborn-HEAD project disables the box with the no-commits hint', async () => {
  const { dom } = await open({ name: 'p', isGitRepo: true, unbornHead: true });
  assert.equal(dom.sdWorktree.disabled, true);
  assert.equal(dom.sdWorktree.checked, false);
  assert.equal(dom.sdWorktreeHint.textContent,
    'project has no commits yet — make a first commit to use worktrees');
});

test('a user click cannot turn the box on for an unborn-HEAD project, so no worktree is sent', async () => {
  const { window, dom, spawns } = await open({ name: 'p', isGitRepo: true, unbornHead: true });
  // A real user CLICK, not a scripted `.checked = true` — a disabled input
  // swallows it, which is the whole mechanism of the pre-emption. Without the
  // fix the box is live, this click checks it, and worktree:true is sent.
  dom.sdWorktree.click();
  assert.equal(dom.sdWorktree.checked, false, 'the click must not reach a disabled box');
  await closeWithSpawn(window, dom);
  assert.equal(spawns.length, 1);
  assert.ok(!('worktree' in spawns[0]),
    `the pre-emption must keep worktree out of the request: ${JSON.stringify(spawns[0])}`);
});

test('a user click DOES enable the worktree on a normal repo (the click really carries)', async () => {
  const { window, dom, spawns } = await open({ name: 'p', isGitRepo: true });
  dom.sdWorktree.click();
  assert.equal(dom.sdWorktree.checked, true);
  await closeWithSpawn(window, dom);
  assert.equal(spawns[0].worktree, true);
});

test('an explicit worktreeName still force-checks the box on any project shape', async () => {
  for (const project of [
    { name: 'p', isGitRepo: true },
    { name: 'p', isGitRepo: true, unbornHead: true },
  ]) {
    const { dom } = await open(project, { worktreeName: 'w' });
    assert.equal(dom.sdWorktree.checked, true);
    assert.equal(dom.sdWorktree.disabled, true);
    assert.equal(dom.sdWorktreeHint.textContent, 'will spawn into existing worktree: w');
  }
});
