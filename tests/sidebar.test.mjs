// DOM-level tests for the unified Sessions sidebar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function setupSidebar({ onLoadSessions } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;

  const { Sidebar } = await import(pathToFileURL(path.join(PUB, 'sidebar.js')).href);
  document.body.innerHTML = '<ul id="root"></ul>';
  const root = document.getElementById('root');

  const calls = { select: [], create: [], resume: [], removeWorktree: [], deleteProject: [] };
  const sidebar = new Sidebar({
    rootList: root,
    onSelectInstance: (id) => calls.select.push(id),
    onCreateInstanceClick: (name, opts) => calls.create.push({ name, opts }),
    onResumeSession: (s) => calls.resume.push(s),
    onRemoveWorktree: (p, w) => calls.removeWorktree.push({ p, w }),
    onDeleteProject: (p) => calls.deleteProject.push(p),
    onLoadSessions: onLoadSessions ?? (async () => []),
  });
  return { window, document, root, sidebar, calls };
}

test('Sessions subnode merges a live instance with its on-disk row (single combined entry)', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [
      { sessionId: 'sid-running', firstPrompt: 'old prompt', mtime: Date.now() - 60_000, size: 100 },
      { sessionId: 'sid-historical', firstPrompt: 'historical', mtime: Date.now() - 3600_000, size: 50 },
    ],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', instanceIds: [],
    isGitRepo: false, worktrees: [],
    sessions: { count: 2, lastMtime: Date.now() - 60_000 },
  }]);
  sidebar.setInstances([
    { id: 'inst-a', project: 'demo', sessionId: 'sid-running', status: 'turn', mode: 'plan', worktree: null },
  ]);

  // The subnode is default-expanded; wait a tick for the lazy load.
  await new Promise(r => setTimeout(r, 0));
  const rows = root.querySelectorAll('.session-row');
  assert.equal(rows.length, 2, `expected 2 merged rows, got ${rows.length}`);
  // The running session row has the live-class + a status dot reflecting turn.
  const liveRow = root.querySelector('.session-row.live');
  assert.ok(liveRow, 'one row must carry the .live class');
  assert.ok(liveRow.querySelector('.dot.turn'), 'the live row\'s dot reflects the instance status (turn)');
  // The historical row gets the offline outline.
  const offlineRow = [...rows].find(r => !r.classList.contains('live'));
  assert.ok(offlineRow.querySelector('.dot.offline'), 'historical row has offline dot');
});

test('Sessions subnode renders a synthetic row for a freshly-spawned instance with no on-disk jsonl', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [], // no on-disk sessions
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', instanceIds: [],
    isGitRepo: false, worktrees: [],
    sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst-fresh', project: 'demo', sessionId: 'sid-fresh', status: 'spawning', mode: 'plan', worktree: null },
  ]);

  // No on-disk sessions but one live instance — subnode still shows (count = 1).
  await new Promise(r => setTimeout(r, 0));
  const rows = root.querySelectorAll('.session-row');
  assert.equal(rows.length, 1);
  const preview = rows[0].querySelector('.session-preview').textContent;
  assert.equal(preview, '(new session)', 'fresh row uses the (new session) placeholder');
  assert.ok(rows[0].querySelector('.dot.spawning'), 'dot reflects spawning status');
});

test('Clicking a live session row calls onSelectInstance; clicking a historical row calls onResumeSession', async () => {
  const now = Date.now();
  const { root, sidebar, calls } = await setupSidebar({
    onLoadSessions: async () => [
      { sessionId: 'sid-live', firstPrompt: 'live', mtime: now - 60_000, size: 10 },
      { sessionId: 'sid-old', firstPrompt: 'old', mtime: now - 3600_000, size: 10 },
    ],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', instanceIds: [],
    isGitRepo: false, worktrees: [],
    sessions: { count: 2, lastMtime: now - 60_000 },
  }]);
  sidebar.setInstances([
    { id: 'inst-x', project: 'demo', sessionId: 'sid-live', status: 'idle', mode: 'plan', worktree: null },
  ]);

  await new Promise(r => setTimeout(r, 0));
  const rows = [...root.querySelectorAll('.session-row')];
  const liveRow = rows.find(r => r.classList.contains('live'));
  const oldRow = rows.find(r => !r.classList.contains('live'));

  liveRow.click();
  assert.deepEqual(calls.select, ['inst-x'], 'live row → onSelectInstance');
  assert.deepEqual(calls.resume, [], 'live row does NOT trigger resume');

  oldRow.click();
  assert.equal(calls.resume.length, 1, 'old row → onResumeSession');
  assert.equal(calls.resume[0].sessionId, 'sid-old');
  assert.equal(calls.resume[0].projectName, 'demo');
  assert.equal(calls.resume[0].worktreeName, null);
});

test('Worktree row carries its own Sessions subnode, scoped to its own live instances', async () => {
  const now = Date.now();
  const { root, sidebar, calls } = await setupSidebar({
    onLoadSessions: async (projectName, worktreeName) => {
      // Two separate session histories — project root vs the worktree.
      if (worktreeName) {
        return [{ sessionId: 'wt-sid', firstPrompt: 'in worktree', mtime: now - 30_000, size: 10 }];
      }
      return [{ sessionId: 'root-sid', firstPrompt: 'at root', mtime: now - 60_000, size: 10 }];
    },
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', instanceIds: [], isGitRepo: true,
    sessions: { count: 1, lastMtime: now - 60_000 },
    worktrees: [{
      worktreeName: 'demo_worktree_abc123', branch: 'claude-orch/abc123',
      baseBranch: 'main', baseSha: 'deadbeef0000', parentProject: 'demo',
      sessions: { count: 1, lastMtime: now - 30_000 },
    }],
  }]);
  sidebar.setInstances([
    { id: 'inst-root', project: 'demo', sessionId: 'root-sid', status: 'idle', mode: 'plan', worktree: null },
    { id: 'inst-wt', project: 'demo', sessionId: 'wt-sid', status: 'turn', mode: 'bypassPermissions',
      worktree: { worktreeName: 'demo_worktree_abc123', branch: 'claude-orch/abc123', baseBranch: 'main', baseSha: 'deadbeef0000' } },
  ]);

  // Expand the worktree subnode (default-collapsed).
  const worktreeDet = root.querySelector('details.worktree-group');
  worktreeDet.open = true;

  await new Promise(r => setTimeout(r, 0));
  const sessionsGroups = root.querySelectorAll('details.sessions-group');
  assert.equal(sessionsGroups.length, 2,
    `expected one Sessions subnode at project root + one inside the worktree, got ${sessionsGroups.length}`);

  // The root-level Sessions subnode shouldn't list the worktree's session.
  const rootGroup = root.querySelector(':scope > li > details.sessions-group');
  const rootRowPreviews = [...rootGroup.querySelectorAll('.session-row .session-preview')].map(n => n.textContent);
  assert.ok(rootRowPreviews.some(t => /at root/.test(t)), 'root subnode lists the root session');
  assert.ok(!rootRowPreviews.some(t => /in worktree/.test(t)), 'root subnode does NOT leak worktree sessions');

  // The worktree-scoped subnode lists only its own session.
  const wtGroup = root.querySelector('.worktree-item details.sessions-group');
  const wtPreviews = [...wtGroup.querySelectorAll('.session-row .session-preview')].map(n => n.textContent);
  assert.deepEqual(wtPreviews, ['in worktree'], 'worktree subnode shows only its own session');

  // Clicking a worktree-scoped historical session resumes with the worktree name.
  // (Here both rows are live, so make the worktree session historical first.)
  sidebar.setInstances([
    { id: 'inst-root', project: 'demo', sessionId: 'root-sid', status: 'idle', mode: 'plan', worktree: null },
  ]);
  // Reopen the worktree details since render re-creates DOM.
  const det2 = root.querySelector('details.worktree-group');
  det2.open = true;
  await new Promise(r => setTimeout(r, 0));
  const wtRow = root.querySelector('.worktree-item .session-row');
  wtRow.click();
  assert.equal(calls.resume.length, 1);
  assert.equal(calls.resume[0].worktreeName, 'demo_worktree_abc123');
  assert.equal(calls.resume[0].sessionId, 'wt-sid');
});

test('Sessions subnode is default-expanded; manual collapse persists across re-renders', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [
      { sessionId: 's', firstPrompt: 'hi', mtime: Date.now(), size: 10 },
    ],
  });
  sidebar.setProjects([{
    name: 'p', path: '/x', instanceIds: [], isGitRepo: false, worktrees: [],
    sessions: { count: 1, lastMtime: Date.now() },
  }]);
  sidebar.setInstances([]);
  // Default expanded.
  let det = root.querySelector('details.sessions-group');
  assert.ok(det.hasAttribute('open'), 'default-expanded');

  // User collapses.
  det.open = false;
  // Re-render via setInstances (a different status update would do this).
  sidebar.setInstances([]);
  det = root.querySelector('details.sessions-group');
  assert.ok(!det.hasAttribute('open'), 'manual collapse persists across re-render');
});
