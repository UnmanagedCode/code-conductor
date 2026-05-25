import { el } from './blocks.js';

// Compact "X min/hr/days ago" formatter. Used by the Sessions subnode
// so the user can see at-a-glance which sessions are recent enough to
// be worth resuming.
function formatAgo(ms) {
  if (!ms) return 'never';
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// Merge an on-disk session list with live instances scoped to a project
// (and optionally a worktree). Each running instance is overlaid onto
// its matching on-disk entry; running instances whose .jsonl isn't on
// disk yet (e.g. a freshly-spawned instance before its first turn) are
// added as synthetic "fresh" entries at the top.
function mergeLive(onDisk, liveInstances) {
  const byId = new Map((onDisk ?? []).map(s => [s.sessionId, { ...s }]));
  for (const inst of liveInstances) {
    if (!inst.sessionId) continue;
    if (byId.has(inst.sessionId)) {
      const row = byId.get(inst.sessionId);
      row.instanceId = inst.id;
      row.instanceStatus = inst.status;
      row.instanceMode = inst.mode;
      row.instanceTemp = !!inst.temp;
    } else {
      byId.set(inst.sessionId, {
        sessionId: inst.sessionId,
        firstPrompt: null,
        mtime: Date.now(),
        size: 0,
        instanceId: inst.id,
        instanceStatus: inst.status,
        instanceMode: inst.mode,
        instanceTemp: !!inst.temp,
        synthetic: true,
      });
    }
  }
  const out = [...byId.values()];
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// localStorage key for the set of collapsed workspace headers. Sessions
// and worktree collapse state is session-local, but workspaces are
// higher-level navigation — surviving a refresh is worth the extra
// persistence.
const WORKSPACES_COLLAPSED_STORAGE_KEY = 'code-conductor:workspaces-collapsed';

function loadCollapsedWorkspaces() {
  try {
    const raw = localStorage.getItem(WORKSPACES_COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter(s => typeof s === 'string'));
  } catch {
    return new Set();
  }
}
function saveCollapsedWorkspaces(set) {
  try {
    if (set.size === 0) localStorage.removeItem(WORKSPACES_COLLAPSED_STORAGE_KEY);
    else localStorage.setItem(WORKSPACES_COLLAPSED_STORAGE_KEY, JSON.stringify([...set]));
  } catch { /* private mode / quota — best-effort */ }
}

// Temp Sessions subnodes default-collapsed; we persist the set the user
// has *opened* so a refresh keeps the layout. localStorage values are
// project names (no worktree split — temp sessions never run inside
// worktrees).
const TEMP_SESSIONS_EXPANDED_STORAGE_KEY = 'code-conductor:temp-sessions-expanded';

function loadExpandedTempSessions() {
  try {
    const raw = localStorage.getItem(TEMP_SESSIONS_EXPANDED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter(s => typeof s === 'string'));
  } catch {
    return new Set();
  }
}
function saveExpandedTempSessions(set) {
  try {
    if (set.size === 0) localStorage.removeItem(TEMP_SESSIONS_EXPANDED_STORAGE_KEY);
    else localStorage.setItem(TEMP_SESSIONS_EXPANDED_STORAGE_KEY, JSON.stringify([...set]));
  } catch { /* private mode / quota — best-effort */ }
}

export class Sidebar {
  constructor({
    rootList, onSelectInstance, onCreateInstanceClick,
    onRemoveWorktree, onDeleteProject, onResumeSession, onLoadSessions,
    onDeleteSession, onEditWorkspace, onQuickSpawn, onPromoteSession,
  }) {
    this.list = rootList;
    this.onSelectInstance = onSelectInstance;
    this.onCreateInstanceClick = onCreateInstanceClick;
    this.onRemoveWorktree = onRemoveWorktree;
    this.onDeleteProject = onDeleteProject;
    this.onResumeSession = onResumeSession;
    this.onLoadSessions = onLoadSessions;
    this.onDeleteSession = onDeleteSession;
    this.onEditWorkspace = onEditWorkspace;
    this.onQuickSpawn = onQuickSpawn;
    this.onPromoteSession = onPromoteSession;
    this.projects = [];
    this.instances = [];
    // Names of registered workspaces (from GET /api/workspaces). Render
    // unions this with the set derived from project.workspace values so
    // empty workspaces still appear.
    this.workspaces = [];
    this.activeInstanceId = null;
    // Sessions subnodes default to expanded — they are the primary
    // navigation. We track only the keys the user has EXPLICITLY
    // collapsed so manual collapse sticks across re-renders.
    this.collapsedSessions = new Set();   // key: `${projectName}` or `${projectName}:${worktreeName}`
    this.expandedWorktrees = new Set();   // key: projectName (worktree subnodes stay default-collapsed)
    this.expandedTempSessions = loadExpandedTempSessions(); // key: projectName (temp subnodes default-collapsed)
    // Workspace containers default-expanded and persist their collapsed
    // state in localStorage so a page refresh keeps the layout stable.
    this.collapsedWorkspaces = loadCollapsedWorkspaces(); // key: workspace name
    // Cached lazy-loaded session lists keyed the same way as
    // collapsedSessions. The cache holds the on-disk list; live
    // instances are merged in fresh on every render so status dots
    // stay up to date.
    this.sessionsCache = new Map();       // key → array
    // Previous status per known instance id. setInstances uses this to
    // detect "turn just ended" transitions, which imply the session's
    // jsonl was just written and the matching subnode's cache is now
    // stale (firstPrompt may have just appeared, mtime advanced, etc.).
    this._prevStatusById = new Map();
    // Per-sessionId count of turn_notifications that landed while the
    // user wasn't viewing this session. Driven from app.js; cleared on
    // selectInstance. Keyed by sessionId so it survives crash + resume
    // (a new instance id for the same session).
    this.unreadBySessionId = new Map();
  }

  setProjects(projects) { this.projects = projects; this.render(); }
  setWorkspaces(names) {
    const arr = Array.isArray(names) ? names.filter(n => typeof n === 'string') : [];
    this.workspaces = [...new Set(arr)];
    this.render();
  }
  setUnread(map) { this.unreadBySessionId = map ?? new Map(); this.render(); }
  setInstances(instances) {
    // Detect new sessionIds appearing/disappearing — when they do, the
    // affected subnodes' cached lists are stale (a synthetic row was
    // added or a now-running instance materialised an on-disk jsonl).
    // Drop those caches so the next render's merge picks up fresh data.
    const oldSids = new Set(this.instances.map(i => i.sessionId));
    const newSids = new Set(instances.map(i => i.sessionId));
    let changed = false;
    for (const s of oldSids) if (!newSids.has(s)) { changed = true; break; }
    if (!changed) for (const s of newSids) if (!oldSids.has(s)) { changed = true; break; }
    if (changed) this.sessionsCache.clear();

    // Per-instance: when status transitions to `idle` (a turn just
    // ended → CLI flushed user/assistant lines and the orchestrator
    // appended last-prompt metadata), invalidate that instance's
    // subnode cache so the next render reloads the on-disk list and
    // picks up the real firstPrompt / mtime in place of the synthetic
    // "(new session)" placeholder.
    const nextStatus = new Map();
    for (const inst of instances) {
      nextStatus.set(inst.id, inst.status);
      const prev = this._prevStatusById.get(inst.id);
      if (prev && prev !== 'idle' && inst.status === 'idle') {
        const key = inst.worktree?.worktreeName
          ? `${inst.project}:${inst.worktree.worktreeName}`
          : inst.project;
        this.sessionsCache.delete(key);
      }
    }
    this._prevStatusById = nextStatus;

    this.instances = instances;
    this.render();
  }
  setActive(id) { this.activeInstanceId = id; this.render(); }

  // Build a session row. The status dot reflects the running-instance
  // status when one is attached; otherwise we render a dim "○" so the
  // user can tell at a glance which sessions are alive.
  _sessionRow({ session, projectName, worktreeName }) {
    const preview = (session.firstPrompt ?? '').slice(0, 80).replace(/\s+/g, ' ').trim();
    const liveLabel = preview || (session.synthetic ? '(new session)' : `${session.sessionId.slice(0, 8)}…`);
    const isLive = !!session.instanceId;
    const status = session.instanceStatus ?? 'offline';
    const isActive = session.instanceId === this.activeInstanceId;
    const unread = this.unreadBySessionId.get(session.sessionId) ?? 0;
    const row = el('div', {
      class: 'session-row' + (isActive ? ' active' : '') + (isLive ? ' live' : '') + (unread > 0 ? ' has-unread' : ''),
      title: `${session.sessionId}${preview ? '\n' + preview : ''}`,
      onclick: () => {
        if (session.instanceId) this.onSelectInstance(session.instanceId);
        else if (this.onResumeSession) this.onResumeSession({
          projectName, worktreeName, sessionId: session.sessionId,
        });
      },
    },
      el('span', { class: `dot ${status}`, title: status }),
      el('span', { class: 'session-ago' }, formatAgo(session.mtime)),
      el('span', { class: 'session-preview' }, liveLabel),
    );
    if (unread > 0) {
      row.appendChild(el('span', {
        class: 'session-unread',
        title: `${unread} new turn${unread === 1 ? '' : 's'} since you last viewed this session`,
      }, String(unread)));
    }
    // Live temp instance → show the promote button to the left of ×.
    // Always visible (no opacity:0 hover) so mobile users can tap it.
    if (session.instanceTemp && session.instanceId) {
      row.appendChild(el('button', {
        class: 'session-promote', title: 'promote to normal session',
        onclick: (e) => {
          e.stopPropagation();
          if (this.onPromoteSession) this.onPromoteSession({
            projectName, instanceId: session.instanceId, preview: liveLabel,
          });
        },
      }, '↑'));
    }
    row.appendChild(el('button', {
      class: 'session-delete', title: 'delete session',
      onclick: (e) => {
        e.stopPropagation();
        if (this.onDeleteSession) this.onDeleteSession({
          projectName, worktreeName, sessionId: session.sessionId,
          preview: liveLabel,
        });
      },
    }, '×'));
    return row;
  }

  // Sessions subnode. Renders against a merged list of (cached on-disk
  // sessions) ∪ (live instances scoped to this subnode). The on-disk
  // half is lazy-loaded the first time the subnode is expanded; live
  // instances are layered on top of every render.
  _sessionsNode({ project, worktreeName = null, liveInstances, summary }) {
    const key = worktreeName ? `${project.name}:${worktreeName}` : project.name;
    // Total visible count = on-disk count + live instances whose
    // sessionId isn't already on disk. The on-disk summary number is
    // authoritative for on-disk; we add a small +N for fresh live
    // ones so the header reflects reality even before first turn.
    const onDiskCount = summary?.count ?? 0;
    let extra = 0;
    if (onDiskCount > 0 || liveInstances.length > 0) {
      const cached = this.sessionsCache.get(key);
      if (cached) {
        const onDiskSids = new Set(cached.map(s => s.sessionId));
        for (const inst of liveInstances) {
          if (inst.sessionId && !onDiskSids.has(inst.sessionId)) extra++;
        }
      } else {
        // Without a loaded cache we can't dedup against the on-disk
        // set, so optimistically assume every live instance is a
        // fresh one. Worst case the count is slightly inflated until
        // the user expands and we get accurate data.
        extra = liveInstances.length;
      }
    }
    const total = onDiskCount + extra;
    if (total === 0) return null;

    const det = el('details', { class: 'sessions-group' });
    if (!this.collapsedSessions.has(key)) det.setAttribute('open', '');

    const liveSummary = liveInstances.length > 0
      ? ` · ${liveInstances.length} live`
      : '';
    const lastLabel = summary?.lastMtime ? ` · last ${formatAgo(summary.lastMtime)}` : '';
    const summaryEl = el('summary', { class: 'sessions-summary' },
      `Sessions (${total})${liveSummary}${lastLabel}`);
    const listEl = el('ul', { class: 'sessions-list' });
    det.appendChild(summaryEl);
    det.appendChild(listEl);

    const renderList = (onDisk) => {
      listEl.innerHTML = '';
      const merged = mergeLive(onDisk, liveInstances);
      if (merged.length === 0) {
        listEl.appendChild(el('li', { class: 'sessions-empty' }, 'no sessions'));
        return;
      }
      for (const s of merged) {
        listEl.appendChild(el('li', {}, this._sessionRow({
          session: s, projectName: project.name, worktreeName,
        })));
      }
    };

    det.addEventListener('toggle', async () => {
      if (det.open) {
        this.collapsedSessions.delete(key);
        const cached = this.sessionsCache.get(key);
        if (cached) {
          renderList(cached);
        } else {
          listEl.innerHTML = '';
          listEl.appendChild(el('li', { class: 'sessions-empty' }, 'loading…'));
          try {
            const onDisk = this.onLoadSessions
              ? await this.onLoadSessions(project.name, worktreeName)
              : [];
            this.sessionsCache.set(key, onDisk);
            renderList(onDisk);
          } catch (e) {
            listEl.innerHTML = '';
            listEl.appendChild(el('li', { class: 'sessions-empty' }, `failed: ${e.message}`));
          }
        }
      } else {
        this.collapsedSessions.add(key);
      }
    });

    // If we already have cached on-disk data, render the merged list
    // immediately so the initially-open subnode is populated. If no
    // cache yet but the subnode is open (first paint with default
    // expanded), kick off a lazy load and render once it lands.
    const cached = this.sessionsCache.get(key);
    if (cached) {
      renderList(cached);
    } else if (det.hasAttribute('open')) {
      listEl.appendChild(el('li', { class: 'sessions-empty' }, 'loading…'));
      (async () => {
        try {
          const onDisk = this.onLoadSessions
            ? await this.onLoadSessions(project.name, worktreeName)
            : [];
          this.sessionsCache.set(key, onDisk);
          // Only re-render this listEl if it's still in the DOM (the
          // user might have re-rendered the sidebar in the meantime,
          // in which case this listEl is orphaned and a fresh render
          // will pick up the cache).
          if (listEl.isConnected) renderList(onDisk);
        } catch (e) {
          if (listEl.isConnected) {
            listEl.innerHTML = '';
            listEl.appendChild(el('li', { class: 'sessions-empty' }, `failed: ${e.message}`));
          }
        }
      })();
    }

    return det;
  }

  // Default-collapsed sibling of the regular Sessions subnode that lists
  // only live temp instances for this project. Temp sessions never live
  // on disk (their jsonl is wiped on exit) so this subnode is a purely
  // live overlay — when the last temp instance exits, the subnode hides
  // itself. Returns null when there's nothing to show, so empty subnodes
  // don't add visual noise.
  _tempSessionsNode({ project, tempInstances }) {
    if (!tempInstances || tempInstances.length === 0) return null;
    const projectName = project.name;
    const det = el('details', { class: 'sessions-group temp-sessions-group' });
    if (this.expandedTempSessions.has(projectName)) det.setAttribute('open', '');
    det.addEventListener('toggle', () => {
      if (det.open) this.expandedTempSessions.add(projectName);
      else this.expandedTempSessions.delete(projectName);
      saveExpandedTempSessions(this.expandedTempSessions);
    });
    det.appendChild(el('summary', { class: 'sessions-summary' },
      `Temp Sessions (${tempInstances.length})`));
    const listEl = el('ul', { class: 'sessions-list' });
    // Reuse mergeLive with an empty on-disk list — we want the same
    // shape (instanceId / instanceStatus / instanceTemp wiring) as the
    // regular subnode, so _sessionRow's promote button kicks in.
    const merged = mergeLive([], tempInstances);
    for (const s of merged) {
      listEl.appendChild(el('li', {}, this._sessionRow({
        session: s, projectName, worktreeName: null,
      })));
    }
    det.appendChild(listEl);
    return det;
  }

  _worktreeNode({ project, wt, liveInstances }) {
    const head = el('div', { class: 'worktree-row' },
      el('span', { class: 'worktree-name', title: `${wt.branch}\nfrom ${wt.baseBranch} @ ${wt.baseSha?.slice(0, 12) ?? '?'}` },
        wt.worktreeName.replace(`${project.name}_worktree_`, ''),
      ),
    );
    const status = wt.mergeStatus;
    if (status && (status.ahead > 0 || status.behind > 0)) {
      let label, title;
      if (status.ahead > 0 && status.behind > 0) {
        label = `↑${status.ahead} ↓${status.behind}`;
        title = `${status.ahead} commit(s) ahead of ${wt.baseBranch}, ${status.behind} behind — rebase, then fast-forward`;
      } else if (status.ahead > 0) {
        label = `↑${status.ahead}`;
        title = `${status.ahead} commit(s) ahead of ${wt.baseBranch} — fast-forward parent to land them`;
      } else {
        label = `↓${status.behind}`;
        title = `${status.behind} commit(s) behind ${wt.baseBranch} — click Sync to catch up`;
      }
      head.appendChild(el('span', { class: 'wt-unmerged', title }, label));
    }
    head.appendChild(el('span', { class: 'worktree-base' }, `← ${wt.baseBranch}`));
    head.appendChild(el('button', {
      class: 'wt-spawn', title: 'new session in this worktree',
      onclick: (e) => { e.stopPropagation(); this.onCreateInstanceClick(project.name, { worktreeName: wt.worktreeName }); },
    }, '+'));
    head.appendChild(el('button', {
      class: 'wt-remove', title: 'remove worktree',
      onclick: (e) => { e.stopPropagation(); this.onRemoveWorktree(project.name, wt.worktreeName); },
    }, '×'));
    const sessions = this._sessionsNode({
      project,
      worktreeName: wt.worktreeName,
      liveInstances,
      summary: wt.sessions,
    });
    return el('li', { class: 'worktree-item' }, head, sessions);
  }

  // Build a single project's list item (project row + Sessions subnode +
  // Worktrees subnode). Pulled out of render() so the same renderer
  // produces unassigned items at the top level AND items nested inside
  // a workspace's <details> body — the row markup is identical either way.
  _projectItem({ project: p, directByProject, byWorktree }) {
    const allDirects = directByProject.get(p.name) ?? [];
    // Temp instances are routed to their own subnode below; the regular
    // Sessions list excludes them so a temp session never appears twice.
    const tempDirects = allDirects.filter(i => i.temp);
    const directs = allDirects.filter(i => !i.temp);
    const worktrees = Array.isArray(p.worktrees) ? p.worktrees : [];
    const li = el('li', {});
    const row = el('div', { class: 'project-row' },
      el('span', { class: 'project-name' }, p.name),
    );
    const ms = p.mergeStatus;
    if (ms && ms.upstream && (ms.ahead > 0 || ms.behind > 0)) {
      const upstream = ms.upstream;
      let label, title;
      if (ms.ahead > 0 && ms.behind > 0) {
        label = `↑${ms.ahead} ↓${ms.behind}`;
        title = `${ms.ahead} commit(s) ahead of ${upstream}, ${ms.behind} behind — pull (or rebase) then push`;
      } else if (ms.ahead > 0) {
        label = `↑${ms.ahead}`;
        title = `${ms.ahead} commit(s) ahead of ${upstream} — push to publish`;
      } else {
        label = `↓${ms.behind}`;
        title = `${ms.behind} commit(s) behind ${upstream} — pull to catch up`;
      }
      row.appendChild(el('span', { class: 'wt-unmerged', title }, label));
    }
    row.appendChild(el('button', {
      class: 'quick-spawn', title: 'quick temp session',
      onclick: (e) => {
        e.stopPropagation();
        if (this.onQuickSpawn) this.onQuickSpawn(p.name);
      },
    }, '⚡'));
    row.appendChild(el('button', {
      class: 'add-instance', title: 'new session',
      onclick: () => this.onCreateInstanceClick(p.name),
    }, '+'));
    row.appendChild(el('button', {
      class: 'delete-project', title: 'delete project',
      onclick: (e) => { e.stopPropagation(); this.onDeleteProject(p); },
    }, '×'));
    li.appendChild(row);

    const sessionsNode = this._sessionsNode({
      project: p,
      liveInstances: directs,
      summary: p.sessions,
    });
    if (sessionsNode) li.appendChild(sessionsNode);
    else if (worktrees.length === 0 && tempDirects.length === 0) {
      // Project with neither sessions nor worktrees nor temp instances
      // — show a tiny "no sessions yet" hint to make the "+" / "⚡"
      // buttons discoverable.
      li.appendChild(el('div', { class: 'empty-project-hint' }, 'no sessions yet — tap ⚡ or + to start'));
    }

    const tempNode = this._tempSessionsNode({ project: p, tempInstances: tempDirects });
    if (tempNode) li.appendChild(tempNode);

    if (worktrees.length > 0) {
      const det = el('details', { class: 'worktree-group' });
      if (this.expandedWorktrees.has(p.name)) det.setAttribute('open', '');
      det.addEventListener('toggle', () => {
        if (det.open) this.expandedWorktrees.add(p.name);
        else this.expandedWorktrees.delete(p.name);
      });
      det.appendChild(el('summary', { class: 'worktree-summary' },
        `Worktrees (${worktrees.length})`));
      const wtUl = el('ul', { class: 'worktree-list' });
      for (const wt of worktrees) {
        const key = `${p.name}:${wt.worktreeName}`;
        const attached = byWorktree.get(key) ?? [];
        wtUl.appendChild(this._worktreeNode({
          project: p, wt, liveInstances: attached,
        }));
      }
      det.appendChild(wtUl);
      li.appendChild(det);
    }

    return li;
  }

  render() {
    // Bucket live instances by (project, worktree?) so the per-subnode
    // merge into Sessions has only the relevant live overlay.
    const directByProject = new Map();
    const byWorktree = new Map();
    for (const i of this.instances) {
      if (i.worktree?.worktreeName) {
        const key = `${i.project}:${i.worktree.worktreeName}`;
        let arr = byWorktree.get(key);
        if (!arr) { arr = []; byWorktree.set(key, arr); }
        arr.push(i);
      } else {
        let arr = directByProject.get(i.project);
        if (!arr) { arr = []; directByProject.set(i.project, arr); }
        arr.push(i);
      }
    }

    this.list.innerHTML = '';
    if (this.projects.length === 0) {
      this.list.appendChild(el('li', { class: 'project-row' },
        el('span', { class: 'project-name' }, 'no projects yet')));
      return;
    }

    // Split into workspace-assigned (rendered first, nested under
    // <details>) and unassigned (rendered flat underneath). Workspace
    // order is alphabetical for v1 — explicit ordering can come later.
    // `project.workspace` is whatever the server returned (the trimmed
    // string from the project's central-store project.json) or
    // null/missing. The set of rendered workspaces is the union of
    // (registered workspaces from GET /api/workspaces) and (workspaces
    // referenced by any project), so empty workspaces still appear.
    const unassigned = [];
    const byWorkspace = new Map();
    for (const p of this.projects) {
      const w = (typeof p.workspace === 'string' && p.workspace.trim() !== '') ? p.workspace.trim() : null;
      if (w) {
        let arr = byWorkspace.get(w);
        if (!arr) { arr = []; byWorkspace.set(w, arr); }
        arr.push(p);
      } else {
        unassigned.push(p);
      }
    }
    for (const name of this.workspaces) {
      if (!byWorkspace.has(name)) byWorkspace.set(name, []);
    }

    const workspaceNames = [...byWorkspace.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of workspaceNames) {
      const members = byWorkspace.get(name);
      const det = el('details', { class: 'project-workspace' });
      if (!this.collapsedWorkspaces.has(name)) det.setAttribute('open', '');
      det.addEventListener('toggle', () => {
        if (det.open) this.collapsedWorkspaces.delete(name);
        else this.collapsedWorkspaces.add(name);
        saveCollapsedWorkspaces(this.collapsedWorkspaces);
      });
      const summary = el('summary', { class: 'project-workspace-summary' },
        el('span', { class: 'project-workspace-name' }, name),
        el('span', { class: 'project-workspace-count' }, `(${members.length})`),
      );
      summary.appendChild(el('button', {
        class: 'project-workspace-edit',
        title: `edit '${name}'`,
        onclick: (e) => {
          // Prevent the click from toggling the <details> open state and
          // from bubbling into the document-level overflow/popover dismiss
          // handlers.
          e.preventDefault();
          e.stopPropagation();
          if (this.onEditWorkspace) this.onEditWorkspace(name);
        },
      }, '✎'));
      det.appendChild(summary);
      const ul = el('ul', { class: 'project-workspace-list' });
      if (members.length === 0) {
        ul.appendChild(el('li', { class: 'workspace-empty' },
          'no projects in this workspace — tap ✎ to add'));
      } else {
        for (const p of members) {
          ul.appendChild(this._projectItem({ project: p, directByProject, byWorktree }));
        }
      }
      det.appendChild(ul);
      const li = el('li', { class: 'project-workspace-item' });
      li.appendChild(det);
      this.list.appendChild(li);
    }

    for (const p of unassigned) {
      this.list.appendChild(this._projectItem({ project: p, directByProject, byWorktree }));
    }
  }
}
