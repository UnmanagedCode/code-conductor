// THE WEB UI'S SIDE OF A PROJECT ON A SYSTEM (card 2026-0253).
//
// `systemUnreachable` has been on GET /api/projects since P2, and the MCP face
// prints it — but NO `public/` consumer read it, so the sidebar row silently
// downgraded: the commit-log button vanished (it is gated on `isGitRepo`, which
// is deliberately ABSENT rather than false on such a row) and nothing on the
// page said why. Absent facts rendering as an ordinary non-git project is the
// same failure class the server side spent this phase closing — a wrong answer
// that looks like an answer.
//
// So the row keeps its place in the list and carries the reason, and the
// affordances that cannot work are HIDDEN rather than offered:
//   * unreachable → no new-session button, no commit log; a pill saying so.
//   * reachable but not local → the project works, but a WORKER cannot start on
//     it (WORKER_SESSIONS_LOCAL_ONLY), so the new-session button goes and the
//     row says which system it is on.
// Delete stays on both: unregistering is exactly what you can still do.

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
  const calls = { create: [], deleteProject: [] };
  const sidebar = new Sidebar({
    rootList: root,
    onSelectInstance: () => {},
    onCreateInstanceClick: (name) => calls.create.push(name),
    onResumeSession: () => {},
    onRemoveWorktree: () => {},
    onDeleteProject: (p) => calls.deleteProject.push(p),
    onLoadSessions: async () => [],
    onEditWorkspace: () => {},
    onQuickSpawn: () => {},
  });
  return { root, sidebar, calls };
}

const baseProject = (over = {}) => ({
  name: 'demo', path: '/p/demo', sessionIds: [], worktrees: [],
  sessions: { count: 0, lastActivity: 0 },
  system: 'local', systemPath: null, systemUnreachable: null, isGitRepo: true,
  ...over,
});

async function render(project) {
  const { root, sidebar, calls } = await setupSidebar();
  sidebar.setProjects([project]);
  sidebar.setInstances([]);
  await new Promise(r => setTimeout(r, 0));
  return { root, sidebar, calls };
}

// PINS: an ordinary local project is untouched by any of this — the baseline
// every assertion below is a difference from.
test('a local project keeps every affordance and shows no system pill', async () => {
  const { root } = await render(baseProject());
  assert.equal(root.querySelectorAll('.project-row').length, 1);
  assert.equal(root.querySelectorAll('.add-instance').length, 1);
  assert.equal(root.querySelectorAll('.delete-project').length, 1);
  assert.equal(root.querySelectorAll('.commit-log').length, 1);
  assert.equal(root.querySelectorAll('.system-pill').length, 0);
});

// PINS the card: an unreachable system's row STAYS in the list and says why,
// on the page, rather than silently reading as a plain non-git project.
test('an unreachable system renders the reason on the row', async () => {
  const { root } = await render(baseProject({
    system: 'prod-box', systemPath: '/app',
    systemUnreachable: "project 'demo' is on system 'prod-box', which cannot be reached: ETRANSPORT",
    isGitRepo: undefined,
  }));
  assert.equal(root.querySelectorAll('.project-row').length, 1, 'the row never disappears');
  const pill = root.querySelector('.system-pill');
  assert.ok(pill, 'the row carries a system pill');
  assert.match(pill.textContent, /prod-box/, 'naming the system');
  assert.match(pill.getAttribute('title') ?? '', /cannot be reached/,
    'and the refusal itself, so the page says WHY the facts are missing');
  assert.ok(pill.classList.contains('system-pill-unreachable'));
});

// PINS: the affordances that cannot work are hidden rather than offered and
// then failing — the same rule the bucket-3 plugin controls follow.
test('an unreachable system hides the controls that would fail, and keeps delete', async () => {
  const { root } = await render(baseProject({
    system: 'prod-box', systemPath: '/app',
    systemUnreachable: 'nope', isGitRepo: undefined,
  }));
  assert.equal(root.querySelectorAll('.add-instance').length, 0,
    'no new-session button: the session could not start');
  assert.equal(root.querySelectorAll('.commit-log').length, 0,
    'no commit log: there are no measured git facts to show');
  assert.equal(root.querySelectorAll('.delete-project').length, 1,
    'delete stays — unregistering is exactly what still works');
});

// PINS: a REACHABLE remote project is fully usable — including worker sessions,
// which now run the CLI locally and redirect their shell and file tools to the
// system. Nothing is hidden on it.
test('a reachable remote project keeps every affordance, spawn included', async () => {
  const { root } = await render(baseProject({
    system: 'prod-box', systemPath: '/app', systemUnreachable: null, isGitRepo: true,
  }));
  const pill = root.querySelector('.system-pill');
  assert.ok(pill, 'the row says which machine it is on');
  assert.match(pill.textContent, /prod-box/);
  assert.equal(pill.classList.contains('system-pill-unreachable'), false);
  assert.match(pill.getAttribute('title') ?? '', /\/app/, 'and the path on it');
  assert.equal(root.querySelectorAll('.commit-log').length, 1, 'git facts were measured, so the log works');
  assert.equal(root.querySelectorAll('.delete-project').length, 1);
  assert.equal(root.querySelectorAll('.add-instance').length, 1,
    'and a worker can run there, so the button is offered');
});

// PINS: the row is reconciled, not rebuilt — a system that comes back must clear
// the pill and restore the controls without a teardown.
test('a system coming back restores the row in place', async () => {
  const { root, sidebar } = await render(baseProject({
    system: 'prod-box', systemPath: '/app', systemUnreachable: 'down', isGitRepo: undefined,
  }));
  const rowBefore = root.querySelector('.project-row');
  sidebar.setProjects([baseProject()]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(root.querySelector('.project-row'), rowBefore, 'the same element is updated');
  assert.equal(root.querySelectorAll('.system-pill').length, 0);
  assert.equal(root.querySelectorAll('.add-instance').length, 1);
});
