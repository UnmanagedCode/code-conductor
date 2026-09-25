// Shared happy-dom setup for the Conductors-lens / ownership / filter Sidebar
// tests: a fresh Window per call, both lists, the filter root, the strip slot and recorded
// callbacks.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUB = path.resolve(__dirname, '..', 'public');

export async function setupSidebar({ withCss = false, onLoadSessions } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.localStorage = window.localStorage;
  try { window.localStorage.clear(); } catch { /* ignore */ }

  const { Sidebar } = await import(pathToFileURL(path.join(PUB, 'sidebar.js')).href);
  const { conductorColor } = await import(pathToFileURL(path.join(PUB, 'conductorColor.js')).href);
  document.body.innerHTML = `
    <div id="sidebar-strip-slot"></div>
    <div id="conductor-filter" class="conductor-filter"><select id="conductor-filter-select"></select></div>
    <ul id="conductor-list" class="conductor-list"></ul>
    <ul id="project-list" class="project-list"></ul>`;
  if (withCss) {
    const style = document.createElement('style');
    style.textContent = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
    document.head.appendChild(style);
  }
  const root = document.getElementById('project-list');
  const conductorList = document.getElementById('conductor-list');
  const filterRoot = document.getElementById('conductor-filter');
  const select = document.getElementById('conductor-filter-select');
  const strip = document.getElementById('sidebar-strip-slot');

  const calls = { select: [], resume: [], create: [] };
  const sidebar = new Sidebar({
    rootList: root,
    conductorList,
    filterRoot,
    stripRoot: strip,
    onSelectInstance: (id) => calls.select.push(id),
    onCreateInstanceClick: (name, opts) => calls.create.push({ name, opts }),
    onResumeSession: (s) => calls.resume.push(s),
    onRemoveWorktree: () => {},
    onDeleteProject: () => {},
    onLoadSessions: onLoadSessions ?? (async () => []),
    onDeleteSession: () => {},
    onEditWorkspace: () => {},
    onPromoteSession: () => {},
  });
  return { window, root, conductorList, filterRoot, select, strip, sidebar, calls, conductorColor };
}

export const tick = () => new Promise(r => setTimeout(r, 0));

// A `worktrees` entry is a name, or `{ name, sessions }` to give that worktree
// an on-disk session summary.
export function project(name, { worktrees = [], workspace = null, isGitRepo = true, sessions = { count: 0, handCount: 0, lastActivity: 0 } } = {}) {
  return {
    name, path: `/p/${name}`, workspace, isGitRepo, sessionIds: [],
    sessions,
    worktrees: worktrees.map(w => (typeof w === 'string' ? { name: w } : w)).map(w => ({
      worktreeName: w.name, branch: `cc/${w.name}`, baseBranch: 'main', baseSha: 'abc',
      sessions: w.sessions ?? { count: 0, handCount: 0, lastActivity: 0 },
    })),
  };
}

export function conductor(sid, o = {}) {
  return {
    id: `inst-${sid}`, project: '.conduct', sessionId: sid, status: 'idle',
    mode: 'bypassPermissions', worktree: null, temp: true, createdAt: 1000, ...o,
  };
}

export function worker(sid, owner, projectName, wt = null, o = {}) {
  return {
    id: `inst-${sid}`, project: projectName, sessionId: sid, status: 'idle',
    mode: 'default', worktree: wt ? { worktreeName: wt, branch: `cc/${wt}`, baseBranch: 'main' } : null,
    conducted: true, ownerSessionId: owner, createdAt: 2000, ...o,
  };
}

export function hand(sid, projectName, wt = null, o = {}) {
  return worker(sid, null, projectName, wt, { conducted: false, ...o });
}

// The .session-row for a sessionId, anywhere under `root`.
export function rowOf(root, sid) {
  return [...root.querySelectorAll('.session-row')].find(r => r.title.split('\n')[0] === sid) ?? null;
}

// The .worktree-row whose name is `wt`, anywhere under `root`.
export function wtHead(root, wt) {
  return [...root.querySelectorAll('.worktree-row')]
    .find(r => r.querySelector('.worktree-name')?.textContent === wt) ?? null;
}
