// Sidebar tests for the synthetic Conduct row that appears when a live
// instance attached to the hidden .conduct project exists. The .conduct
// project itself is filtered out of listProjects() (dot-prefix rule),
// so without this synthesis the conductor instance would have no parent
// row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function setupSidebar() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.localStorage = window.localStorage;
  try { window.localStorage.clear(); } catch { /* ignore */ }

  const { Sidebar } = await import(pathToFileURL(path.join(PUB, 'sidebar.js')).href);
  document.body.innerHTML = '<ul id="root"></ul>';
  const root = document.getElementById('root');

  const calls = { select: [], create: [], resume: [], removeWorktree: [], deleteProject: [], quickSpawn: [] };
  const sidebar = new Sidebar({
    rootList: root,
    onSelectInstance: (id) => calls.select.push(id),
    onCreateInstanceClick: (name, opts) => calls.create.push({ name, opts }),
    onResumeSession: (s) => calls.resume.push(s),
    onRemoveWorktree: (p, w) => calls.removeWorktree.push({ p, w }),
    onDeleteProject: (p) => calls.deleteProject.push(p),
    onLoadSessions: async () => [],
    onEditWorkspace: () => {},
    onQuickSpawn: (name) => calls.quickSpawn.push(name),
  });
  return { root, sidebar, calls };
}

test('no synthetic Conduct row when there is no live .conduct instance', async () => {
  const { root, sidebar } = await setupSidebar();
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', instanceIds: [],
    isGitRepo: false, worktrees: [],
    sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([]);
  await new Promise(r => setTimeout(r, 0));
  const labels = [...root.querySelectorAll('.project-name')].map(n => n.textContent);
  assert.ok(!labels.includes('🎼 Conduct'), 'no conductor row should appear');
  assert.equal(root.querySelectorAll('.project-conduct').length, 0);
});

test('synthetic 🎼 Conduct row appears at the top when a live .conduct instance exists', async () => {
  const { root, sidebar } = await setupSidebar();
  sidebar.setProjects([{
    name: 'demo', path: '/p/demo', instanceIds: [],
    isGitRepo: false, worktrees: [],
    sessions: { count: 0, lastMtime: 0 },
  }]);
  sidebar.setInstances([
    { id: 'inst-c', project: '.conduct', sessionId: 'sid-c', status: 'idle', mode: 'bypassPermissions', worktree: null, temp: true },
  ]);
  await new Promise(r => setTimeout(r, 0));

  const conductLi = root.querySelector('.project-conduct');
  assert.ok(conductLi, 'conduct row container exists');
  const name = conductLi.querySelector('.project-name').textContent;
  assert.equal(name, '🎼 Conduct');

  // Pinned to the top of the list.
  assert.equal(root.firstElementChild, conductLi, 'conduct row is the first list item');
});

test('synthetic Conduct row hides destructive / spawn buttons', async () => {
  const { root, sidebar } = await setupSidebar();
  sidebar.setProjects([]);
  sidebar.setInstances([
    { id: 'inst-c', project: '.conduct', sessionId: 'sid-c', status: 'idle', mode: 'bypassPermissions', worktree: null, temp: true },
  ]);
  await new Promise(r => setTimeout(r, 0));

  const conductLi = root.querySelector('.project-conduct');
  assert.ok(conductLi, 'conduct row container exists');
  assert.equal(conductLi.querySelector('.delete-project'), null, 'no delete button');
  assert.equal(conductLi.querySelector('.quick-spawn'), null, 'no quick-spawn button');
  assert.equal(conductLi.querySelector('.add-instance'), null, 'no add-instance button');
});

test('Sessions subnode under the Conduct row exposes the live instance and clicking selects it', async () => {
  const { root, sidebar, calls } = await setupSidebar();
  sidebar.setProjects([]);
  sidebar.setInstances([
    { id: 'inst-c', project: '.conduct', sessionId: 'sid-c', status: 'idle', mode: 'bypassPermissions', worktree: null, temp: true },
  ]);
  await new Promise(r => setTimeout(r, 0));

  const conductLi = root.querySelector('.project-conduct');
  const sessionRow = conductLi.querySelector('.session-row');
  assert.ok(sessionRow, 'a session row exists for the live conductor instance');
  sessionRow.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(calls.select, ['inst-c'], 'clicking the row selects the live instance');
});

test('with no projects but a live conductor, "no projects yet" placeholder is suppressed', async () => {
  const { root, sidebar } = await setupSidebar();
  sidebar.setProjects([]);
  sidebar.setInstances([
    { id: 'inst-c', project: '.conduct', sessionId: 'sid-c', status: 'idle', mode: 'bypassPermissions', worktree: null, temp: true },
  ]);
  await new Promise(r => setTimeout(r, 0));

  const labels = [...root.querySelectorAll('.project-name')].map(n => n.textContent);
  assert.ok(!labels.includes('no projects yet'),
    'placeholder is suppressed when at least the conductor row is present');
});
