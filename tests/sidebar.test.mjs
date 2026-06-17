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
  // Sidebar reads/writes localStorage for collapsed-workspaces
  // persistence. happy-dom ships a Storage but we want a clean slate per
  // test so collapse state doesn't leak between cases.
  globalThis.localStorage = window.localStorage;
  try { window.localStorage.clear(); } catch { /* ignore */ }

  const { Sidebar } = await import(pathToFileURL(path.join(PUB, 'sidebar.js')).href);
  document.body.innerHTML = '<ul id="root"></ul>';
  const root = document.getElementById('root');

  const calls = { select: [], create: [], resume: [], removeWorktree: [], deleteProject: [], editWorkspace: [] };
  const sidebar = new Sidebar({
    rootList: root,
    onSelectInstance: (id) => calls.select.push(id),
    onCreateInstanceClick: (name, opts) => calls.create.push({ name, opts }),
    onResumeSession: (s) => calls.resume.push(s),
    onRemoveWorktree: (p, w) => calls.removeWorktree.push({ p, w }),
    onDeleteProject: (p) => calls.deleteProject.push(p),
    onLoadSessions: onLoadSessions ?? (async () => []),
    onEditWorkspace: (g) => calls.editWorkspace.push(g),
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
    name: 'demo', path: '/p/demo', sessionIds: [],
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
    name: 'demo', path: '/p/demo', sessionIds: [],
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
    name: 'demo', path: '/p/demo', sessionIds: [],
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
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: true,
    sessions: { count: 1, lastMtime: now - 60_000 },
    worktrees: [{
      worktreeName: 'demo_worktree_abc123', branch: 'code-conductor/abc123',
      baseBranch: 'main', baseSha: 'deadbeef0000', parentProject: 'demo',
      sessions: { count: 1, lastMtime: now - 30_000 },
    }],
  }]);
  sidebar.setInstances([
    { id: 'inst-root', project: 'demo', sessionId: 'root-sid', status: 'idle', mode: 'plan', worktree: null },
    { id: 'inst-wt', project: 'demo', sessionId: 'wt-sid', status: 'turn', mode: 'bypassPermissions',
      worktree: { worktreeName: 'demo_worktree_abc123', branch: 'code-conductor/abc123', baseBranch: 'main', baseSha: 'deadbeef0000' } },
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

test('Synthetic "(new session)" row refreshes to the real firstPrompt once the jsonl is written (turn ends)', async () => {
  let call = 0;
  const onLoadSessions = async () => {
    call++;
    if (call === 1) return []; // jsonl doesn't exist yet — fresh spawn
    return [{ sessionId: 'sid-fresh', firstPrompt: 'hello world', mtime: Date.now(), size: 1024 }];
  };
  const { root, sidebar } = await setupSidebar({ onLoadSessions });

  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false, worktrees: [],
    sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst', project: 'demo', sessionId: 'sid-fresh', status: 'spawning', mode: 'plan', worktree: null },
  ]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(root.querySelector('.session-preview').textContent, '(new session)');
  assert.equal(call, 1);

  // spawn → idle happens before the first prompt; the jsonl may or may
  // not exist yet. Either way, we invalidate the cache so the next
  // render reflects whatever is on disk now.
  sidebar.setInstances([
    { id: 'inst', project: 'demo', sessionId: 'sid-fresh', status: 'idle', mode: 'plan', worktree: null },
  ]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(call, 2, 'turn→idle (or spawning→idle) must invalidate and refetch');
  assert.equal(root.querySelector('.session-preview').textContent, 'hello world');
});

test('idle → turn does not invalidate the sessions cache; turn → idle does', async () => {
  let call = 0;
  const onLoadSessions = async () => {
    call++;
    return [{ sessionId: 'sid', firstPrompt: 'preview', mtime: call * 1000, size: 100 }];
  };
  const { sidebar } = await setupSidebar({ onLoadSessions });

  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false, worktrees: [],
    sessions: { count: 1, lastMtime: 1000 },
  }]);
  sidebar.setInstances([{ id: 'i', project: 'demo', sessionId: 'sid', status: 'idle', mode: 'plan', worktree: null }]);
  await new Promise(r => setTimeout(r, 0));
  const baseline = call;
  assert.ok(baseline >= 1, 'initial load happened');

  sidebar.setInstances([{ id: 'i', project: 'demo', sessionId: 'sid', status: 'turn', mode: 'plan', worktree: null }]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(call, baseline, 'idle→turn must not invalidate');

  sidebar.setInstances([{ id: 'i', project: 'demo', sessionId: 'sid', status: 'idle', mode: 'plan', worktree: null }]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(call, baseline + 1, 'turn→idle must invalidate and refetch');
});

test('Cache invalidation on turn→idle is scoped to the instance\'s worktree key, not the project root', async () => {
  const calls = [];
  const onLoadSessions = async (projectName, worktreeName) => {
    calls.push({ projectName, worktreeName });
    if (worktreeName) {
      return calls.filter(c => c.worktreeName === worktreeName).length >= 2
        ? [{ sessionId: 'wt-sid', firstPrompt: 'fresh-prompt', mtime: Date.now(), size: 100 }]
        : [];
    }
    return [{ sessionId: 'root-sid', firstPrompt: 'root-prompt', mtime: Date.now() - 60_000, size: 100 }];
  };
  const { root, sidebar } = await setupSidebar({ onLoadSessions });

  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: true,
    sessions: { count: 1, lastMtime: Date.now() - 60_000 },
    worktrees: [{
      worktreeName: 'demo_worktree_xyz', branch: 'code-conductor/xyz',
      baseBranch: 'main', baseSha: 'cafef00d', parentProject: 'demo',
      sessions: { count: 0, lastMtime: 0 },
    }],
  }]);
  sidebar.expandedWorktrees.add('demo');
  sidebar.setInstances([
    { id: 'inst-wt', project: 'demo', sessionId: 'wt-sid', status: 'turn', mode: 'plan',
      worktree: { worktreeName: 'demo_worktree_xyz', branch: 'code-conductor/xyz', baseBranch: 'main', baseSha: 'cafef00d' } },
  ]);
  await new Promise(r => setTimeout(r, 0));

  const rootCallsBefore = calls.filter(c => c.worktreeName == null).length;
  const wtCallsBefore = calls.filter(c => c.worktreeName === 'demo_worktree_xyz').length;
  assert.ok(rootCallsBefore >= 1 && wtCallsBefore >= 1, 'both subnodes loaded initially');

  // turn→idle on the worktree-scoped instance. The root subnode's
  // cache must NOT be invalidated — only the worktree's.
  sidebar.setInstances([
    { id: 'inst-wt', project: 'demo', sessionId: 'wt-sid', status: 'idle', mode: 'plan',
      worktree: { worktreeName: 'demo_worktree_xyz', branch: 'code-conductor/xyz', baseBranch: 'main', baseSha: 'cafef00d' } },
  ]);
  await new Promise(r => setTimeout(r, 0));

  const rootCallsAfter = calls.filter(c => c.worktreeName == null).length;
  const wtCallsAfter = calls.filter(c => c.worktreeName === 'demo_worktree_xyz').length;
  assert.equal(rootCallsAfter, rootCallsBefore, 'project-root cache was NOT invalidated');
  assert.equal(wtCallsAfter, wtCallsBefore + 1, 'worktree-scoped cache WAS invalidated and refetched');

  // And the worktree's preview now shows the refreshed firstPrompt.
  const wtGroup = root.querySelector('.worktree-item details.sessions-group');
  const wtRows = wtGroup.querySelectorAll('.session-row .session-preview');
  assert.equal(wtRows.length, 1);
  assert.equal(wtRows[0].textContent, 'fresh-prompt');
});

test('setUnread renders a numeric pill on the matching session row; clearing the entry removes it', async () => {
  const now = Date.now();
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [
      { sessionId: 'sid-a', firstPrompt: 'aaa', mtime: now - 60_000, size: 10 },
      { sessionId: 'sid-b', firstPrompt: 'bbb', mtime: now - 30_000, size: 10 },
    ],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false, worktrees: [],
    sessions: { count: 2, lastMtime: now - 30_000 },
  }]);
  sidebar.setInstances([
    { id: 'inst-a', project: 'demo', sessionId: 'sid-a', status: 'idle', mode: 'plan', worktree: null },
    { id: 'inst-b', project: 'demo', sessionId: 'sid-b', status: 'idle', mode: 'plan', worktree: null },
  ]);
  await new Promise(r => setTimeout(r, 0));

  // Initially no pills.
  assert.equal(root.querySelectorAll('.session-unread').length, 0);

  sidebar.setUnread(new Map([['sid-b', 3]]));
  await new Promise(r => setTimeout(r, 0));
  const pills = root.querySelectorAll('.session-unread');
  assert.equal(pills.length, 1, 'one pill renders for the unread session');
  assert.equal(pills[0].textContent, '3');
  // The row carrying the pill has the has-unread class.
  const unreadRow = pills[0].closest('.session-row');
  assert.ok(unreadRow.classList.contains('has-unread'));
  // The 'sid-a' row gets no pill.
  const sidARow = [...root.querySelectorAll('.session-row')].find(r => r.title.startsWith('sid-a'));
  assert.ok(!sidARow.querySelector('.session-unread'));

  sidebar.setUnread(new Map());
  await new Promise(r => setTimeout(r, 0));
  assert.equal(root.querySelectorAll('.session-unread').length, 0, 'pill gone after clearing');
});

test('Sessions subnode is default-expanded; manual collapse persists across re-renders', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [
      { sessionId: 's', firstPrompt: 'hi', mtime: Date.now(), size: 10 },
    ],
  });
  sidebar.setProjects([{
    name: 'p', path: '/x', sessionIds: [], isGitRepo: false, worktrees: [],
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

test('Projects with a workspace render under a <details> workspace container at the top; unassigned render flat below', async () => {
  const { root, sidebar } = await setupSidebar({ onLoadSessions: async () => [] });
  sidebar.setProjects([
    { name: 'alpha', path: '/p/alpha', sessionIds: [], isGitRepo: false, worktrees: [],
      sessions: { count: 0, lastMtime: 0 }, workspace: null },
    { name: 'work-thing', path: '/p/work', sessionIds: [], isGitRepo: false, worktrees: [],
      sessions: { count: 0, lastMtime: 0 }, workspace: 'Work' },
    { name: 'play-thing', path: '/p/play', sessionIds: [], isGitRepo: false, worktrees: [],
      sessions: { count: 0, lastMtime: 0 }, workspace: 'Side' },
    { name: 'work-other', path: '/p/wo', sessionIds: [], isGitRepo: false, worktrees: [],
      sessions: { count: 0, lastMtime: 0 }, workspace: 'Work' },
  ]);
  sidebar.setInstances([]);
  // Top-level <li> children: two workspace items (Side, Work — sorted
  // alphabetically) followed by the one unassigned project at the bottom.
  const topLis = [...root.children].filter(n => n.tagName === 'LI');
  assert.ok(topLis[0].classList.contains('project-workspace-item'), 'first row is a workspace');
  assert.ok(topLis[1].classList.contains('project-workspace-item'), 'second row is a workspace');
  assert.equal(topLis[2].querySelector(':scope > .project-row .project-name').textContent, 'alpha');
  const wsItems = topLis.filter(li => li.classList.contains('project-workspace-item'));
  assert.equal(wsItems.length, 2);
  const names = wsItems.map(li => li.querySelector('.project-workspace-name').textContent);
  assert.deepEqual(names, ['Side', 'Work'], 'workspace names sorted alphabetically');
  // The Work workspace has two members.
  const workWs = wsItems[1].querySelector('details.project-workspace');
  const workMembers = workWs.querySelectorAll('.project-workspace-list > li > .project-row .project-name');
  assert.deepEqual(
    [...workMembers].map(n => n.textContent).sort(),
    ['work-other', 'work-thing'],
  );
  // Count label reflects member count.
  assert.equal(wsItems[1].querySelector('.project-workspace-count').textContent, '(2)');
});

test('Empty workspaces (from setWorkspaces) render with (0) count and an empty hint', async () => {
  const { root, sidebar } = await setupSidebar({ onLoadSessions: async () => [] });
  sidebar.setProjects([
    { name: 'alpha', path: '/p/alpha', sessionIds: [], isGitRepo: false, worktrees: [],
      sessions: { count: 0, lastMtime: 0 }, workspace: null },
  ]);
  // The registry knows about a workspace nobody is in.
  sidebar.setWorkspaces(['Lonely']);
  sidebar.setInstances([]);
  const wsItem = root.querySelector('li.project-workspace-item');
  assert.ok(wsItem, 'empty workspace renders an <li>');
  assert.equal(wsItem.querySelector('.project-workspace-name').textContent, 'Lonely');
  assert.equal(wsItem.querySelector('.project-workspace-count').textContent, '(0)');
  assert.ok(wsItem.querySelector('.workspace-empty'), 'empty hint inside the list');
});

test('Clicking the workspace ✎ button calls onEditWorkspace with the name and does not toggle the details', async () => {
  const { root, sidebar, calls } = await setupSidebar({ onLoadSessions: async () => [] });
  sidebar.setProjects([
    { name: 'a', path: '/p/a', sessionIds: [], isGitRepo: false, worktrees: [],
      sessions: { count: 0, lastMtime: 0 }, workspace: 'Stuff' },
  ]);
  sidebar.setInstances([]);
  const det = root.querySelector('details.project-workspace');
  assert.ok(!det.hasAttribute('open'), 'default-collapsed');
  const edit = root.querySelector('.project-workspace-edit');
  edit.click();
  assert.deepEqual(calls.editWorkspace, ['Stuff']);
  // Default-collapsed state still holds — the click on ✎ should not have
  // toggled the surrounding <details>.
  assert.ok(!det.hasAttribute('open'), 'edit click does not expand workspace');
});

test('Workspace expand state is read from localStorage on construction', async () => {
  // Seed the storage key BEFORE constructing the Sidebar so its
  // expandedWorkspaces set initialises from it.
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.localStorage = window.localStorage;
  window.localStorage.setItem('code-conductor:workspaces-expanded', JSON.stringify(['Visible']));
  // happy-dom caches ES modules — break the cache so the freshly-seeded
  // localStorage drives this Sidebar's `loadExpandedWorkspaces` call.
  const url = pathToFileURL(path.join(PUB, 'sidebar.js')).href + `?seed=${Date.now()}`;
  const { Sidebar } = await import(url);
  document.body.innerHTML = '<ul id="root"></ul>';
  const root = document.getElementById('root');
  const sidebar = new Sidebar({
    rootList: root,
    onSelectInstance: () => {}, onCreateInstanceClick: () => {},
    onRemoveWorktree: () => {}, onDeleteProject: () => {},
    onResumeSession: () => {}, onLoadSessions: async () => [],
    onEditWorkspace: () => {},
  });
  sidebar.setProjects([
    { name: 'a', path: '/p/a', sessionIds: [], isGitRepo: false, worktrees: [],
      sessions: { count: 0, lastMtime: 0 }, workspace: 'Hidden' },
    { name: 'b', path: '/p/b', sessionIds: [], isGitRepo: false, worktrees: [],
      sessions: { count: 0, lastMtime: 0 }, workspace: 'Visible' },
  ]);
  sidebar.setInstances([]);
  const workspaces = [...root.querySelectorAll('details.project-workspace')];
  const byName = Object.fromEntries(workspaces.map(g =>
    [g.querySelector('.project-workspace-name').textContent, g]));
  assert.ok(!byName['Hidden'].hasAttribute('open'), 'Hidden workspace is default-collapsed');
  assert.ok(byName['Visible'].hasAttribute('open'), 'Visible workspace respects localStorage expand');
});

test('Temp instances render inside the unified Sessions subnode below a dim separator', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false,
    worktrees: [], sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst-normal', project: 'demo', sessionId: 'sid-normal',
      status: 'idle', mode: 'plan', worktree: null, temp: false },
    { id: 'inst-temp',   project: 'demo', sessionId: 'sid-temp',
      status: 'idle', mode: 'bypassPermissions', worktree: null, temp: true },
  ]);

  await new Promise(r => setTimeout(r, 0));
  // No separate temp subnode anymore — everything lives in the one
  // Sessions <details>.
  assert.equal(root.querySelector('details.temp-sessions-group'), null,
    'separate Temp Sessions subnode has been removed');
  const group = root.querySelector('details.sessions-group');
  assert.ok(group, 'unified Sessions subnode rendered');
  const items = [...group.querySelector('.sessions-list').children];
  // Expect: normal row, separator, temp row — in that order.
  assert.equal(items.length, 3);
  assert.ok(items[0].querySelector('.session-row'), 'first child is the normal row');
  assert.ok(!items[0].querySelector('.session-row').classList.contains('temp'),
    'normal row does not have .temp class');
  assert.ok(items[1].classList.contains('sessions-separator'),
    'middle child is the — temp — separator');
  assert.match(items[1].textContent, /temp/i);
  const tempRow = items[2].querySelector('.session-row');
  assert.ok(tempRow, 'third child is the temp row');
  assert.ok(tempRow.classList.contains('temp'), 'temp row carries .temp class for styling');
});

test('Conducted instances render below a — conducted — separator, separate from temp', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false,
    worktrees: [], sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst-normal', project: 'demo', sessionId: 'sid-normal',
      status: 'idle', mode: 'plan', worktree: null, temp: false, conducted: false },
    { id: 'inst-temp', project: 'demo', sessionId: 'sid-temp',
      status: 'idle', mode: 'bypassPermissions', worktree: null, temp: true, conducted: false },
    { id: 'inst-cond', project: 'demo', sessionId: 'sid-cond',
      status: 'idle', mode: 'plan', worktree: null, temp: false, conducted: true },
  ]);
  await new Promise(r => setTimeout(r, 0));
  const list = root.querySelector('details.sessions-group .sessions-list');
  const items = [...list.children];
  // normal, — temp —, temp, — conducted —, conducted  (5 children)
  assert.equal(items.length, 5);
  const seps = items.filter(li => li.classList.contains('sessions-separator'));
  assert.equal(seps.length, 2, 'two separators rendered');
  assert.match(seps[0].textContent, /temp/i);
  assert.match(seps[1].textContent, /conducted/i);
  // The — conducted — separator is the 4th child; the conducted row follows.
  assert.match(items[3].textContent, /conducted/i);
  const condRow = items[4].querySelector('.session-row');
  assert.ok(condRow, 'conducted row follows the conducted separator');
  assert.ok(condRow.classList.contains('conducted'), 'conducted row carries .conducted class');
  assert.ok(!condRow.classList.contains('temp'), 'pure conducted row is not .temp');
  // The temp row (2nd section) is NOT under conducted and stays .temp.
  const tempRow = items[2].querySelector('.session-row');
  assert.ok(tempRow.classList.contains('temp'));
  assert.ok(!tempRow.classList.contains('conducted'));
});

test('A conducted+temp session groups under — conducted — but keeps the .temp color class', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false,
    worktrees: [], sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst-ct', project: 'demo', sessionId: 'sid-ct',
      status: 'idle', mode: 'bypassPermissions', worktree: null, temp: true, conducted: true },
  ]);
  await new Promise(r => setTimeout(r, 0));
  const items = [...root.querySelector('details.sessions-group .sessions-list').children];
  // Only a conducted section should appear (no — temp — separator, since the
  // sole temp session is also conducted → grouped under conducted).
  const seps = items.filter(li => li.classList.contains('sessions-separator'));
  assert.equal(seps.length, 1, 'only the conducted separator renders');
  assert.match(seps[0].textContent, /conducted/i);
  const row = root.querySelector('.session-row');
  assert.ok(row.classList.contains('conducted'), 'row is in the conducted group');
  assert.ok(row.classList.contains('temp'), 'row keeps .temp so the warm temp color applies');
});

test('On-disk conducted metadata (no live instance) still groups under — conducted —', async () => {
  const { root, sidebar } = await setupSidebar({
    // Historical, non-live session carrying the persisted conducted flag.
    onLoadSessions: async () => [
      { sessionId: 'sid-hist', firstPrompt: 'hi', title: null, conducted: true, mtime: 1, size: 10 },
    ],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false,
    worktrees: [], sessions: { count: 1, lastMtime: 1 },
  }]);
  sidebar.setInstances([]);
  // The subnode is default-expanded; wait a tick for the lazy load.
  await new Promise(r => setTimeout(r, 0));
  const items = [...root.querySelector('details.sessions-group .sessions-list').children];
  const seps = items.filter(li => li.classList.contains('sessions-separator'));
  assert.equal(seps.length, 1);
  assert.match(seps[0].textContent, /conducted/i);
  const row = root.querySelector('.session-row');
  assert.ok(row.classList.contains('conducted'),
    'persisted conducted session groups under conducted even with no live instance');
});

test('Sessions subnode renders no separator when there are zero temp instances', async () => {
  const { root, sidebar } = await setupSidebar({});
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false,
    worktrees: [], sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst-x', project: 'demo', sessionId: 'sid-x',
      status: 'idle', mode: 'plan', worktree: null, temp: false },
  ]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(root.querySelector('.sessions-separator'), null,
    'no separator when there are no temp instances');
});

test('Temp session row exposes a ↑ promote button wired to onPromoteSession', async () => {
  const { root, sidebar } = await setupSidebar({});
  const promoteCalls = [];
  sidebar.onPromoteSession = (arg) => promoteCalls.push(arg);
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false,
    worktrees: [], sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst-temp', project: 'demo', sessionId: 'sid-temp',
      status: 'idle', mode: 'bypassPermissions', worktree: null, temp: true },
  ]);
  await new Promise(r => setTimeout(r, 0));
  const group = root.querySelector('details.sessions-group');
  assert.ok(group, 'Sessions subnode exists when a temp instance is the only entry');
  const btn = group.querySelector('.session-promote');
  assert.ok(btn, 'promote button rendered on the temp row');
  assert.equal(btn.textContent, '↑');
  btn.click();
  assert.equal(promoteCalls.length, 1);
  assert.equal(promoteCalls[0].instanceId, 'inst-temp');
  assert.equal(promoteCalls[0].projectName, 'demo');
});

test('Regular (non-temp) session rows do NOT show the promote button', async () => {
  const { root, sidebar } = await setupSidebar({});
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false,
    worktrees: [], sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst-normal', project: 'demo', sessionId: 'sid-normal',
      status: 'idle', mode: 'plan', worktree: null, temp: false },
  ]);
  await new Promise(r => setTimeout(r, 0));
  const promoteBtn = root.querySelector('.session-promote');
  assert.equal(promoteBtn, null, 'no promote button on non-temp rows');
});

// Regression: after a host crash + restart, sessions are re-discovered from
// disk with NO live instance. The durable temp/conducted flags (from
// temp-sessions.json / conducted-sessions.json, surfaced by listSessionsForCwd
// as `temp` / `conducted`) must still drive the sidebar grouping — previously
// the temp grouping keyed off the live-only `instanceTemp` and dropped exited
// temp sessions into the normal group until they were resumed.

test('Re-discovered temp session with NO live instance groups under — temp —', async () => {
  const now = Date.now();
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [
      { sessionId: 'sid-normal', firstPrompt: 'normal', temp: false, mtime: now - 30_000, size: 10 },
      { sessionId: 'sid-temp', firstPrompt: 'a temp one', temp: true, mtime: now - 60_000, size: 10 },
    ],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false, worktrees: [],
    sessions: { count: 2, lastMtime: now - 30_000 },
  }]);
  sidebar.setInstances([]); // no live instances — the post-restart state
  await new Promise(r => setTimeout(r, 0));

  const sep = [...root.querySelectorAll('.sessions-separator')].find(n => n.textContent === '— temp —');
  assert.ok(sep, 'a — temp — separator must render for the durable temp session');

  const tempRow = [...root.querySelectorAll('.session-row')].find(r => r.classList.contains('temp'));
  assert.ok(tempRow, 'the exited temp session row carries the .temp class from the durable flag');
  // It must sit AFTER the temp separator (i.e. in the temp group, not normal).
  const items = [...root.querySelectorAll('.sessions-list > li')];
  const sepIdx = items.indexOf(sep.closest('li'));
  const tempIdx = items.indexOf(tempRow.closest('li'));
  assert.ok(sepIdx >= 0 && tempIdx > sepIdx, 'temp row is grouped under the — temp — separator');
  // The non-temp row stays out of the temp group (no .temp class).
  const normalRow = [...root.querySelectorAll('.session-row')].find(r => !r.classList.contains('temp'));
  assert.ok(normalRow, 'the non-temp session row is rendered without the .temp class');
});

// (The conducted-from-disk path is already covered by the existing
// "On-disk conducted metadata (no live instance) still groups under
// — conducted —" test above — conducted grouping keys off the durable
// `conducted` flag and was never affected by this bug.)

test('A just-promoted live session (inst.temp=false) overrides a stale on-disk temp:true', async () => {
  const now = Date.now();
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async () => [
      // Disk sidecar not yet unmarked — listSessionsForCwd still reports temp:true.
      { sessionId: 'sid-promoted', firstPrompt: 'promoted', temp: true, mtime: now - 60_000, size: 10 },
    ],
  });
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', sessionIds: [], isGitRepo: false, worktrees: [],
    sessions: { count: 1, lastMtime: now - 60_000 },
  }]);
  // Live instance reports temp:false (the authoritative just-promoted state).
  sidebar.setInstances([
    { id: 'inst-p', project: 'demo', sessionId: 'sid-promoted', status: 'idle', mode: 'plan', worktree: null, temp: false },
  ]);
  await new Promise(r => setTimeout(r, 0));

  const tempSep = [...root.querySelectorAll('.sessions-separator')].find(n => n.textContent === '— temp —');
  assert.equal(tempSep, undefined, 'no — temp — separator: the live temp:false overrides the stale on-disk temp:true');
  const row = root.querySelector('.session-row');
  assert.ok(row && !row.classList.contains('temp'), 'the promoted row is not styled as temp');
});
