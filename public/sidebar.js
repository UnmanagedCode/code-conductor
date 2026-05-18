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
    } else {
      byId.set(inst.sessionId, {
        sessionId: inst.sessionId,
        firstPrompt: null,
        mtime: Date.now(),
        size: 0,
        instanceId: inst.id,
        instanceStatus: inst.status,
        instanceMode: inst.mode,
        synthetic: true,
      });
    }
  }
  const out = [...byId.values()];
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export class Sidebar {
  constructor({
    rootList, onSelectInstance, onCreateInstanceClick,
    onRemoveWorktree, onDeleteProject, onResumeSession, onLoadSessions,
    onDeleteSession,
  }) {
    this.list = rootList;
    this.onSelectInstance = onSelectInstance;
    this.onCreateInstanceClick = onCreateInstanceClick;
    this.onRemoveWorktree = onRemoveWorktree;
    this.onDeleteProject = onDeleteProject;
    this.onResumeSession = onResumeSession;
    this.onLoadSessions = onLoadSessions;
    this.onDeleteSession = onDeleteSession;
    this.projects = [];
    this.instances = [];
    this.activeInstanceId = null;
    // Sessions subnodes default to expanded — they are the primary
    // navigation. We track only the keys the user has EXPLICITLY
    // collapsed so manual collapse sticks across re-renders.
    this.collapsedSessions = new Set();   // key: `${projectName}` or `${projectName}:${worktreeName}`
    this.expandedWorktrees = new Set();   // key: projectName (worktree subnodes stay default-collapsed)
    // Cached lazy-loaded session lists keyed the same way as
    // collapsedSessions. The cache holds the on-disk list; live
    // instances are merged in fresh on every render so status dots
    // stay up to date.
    this.sessionsCache = new Map();       // key → array
  }

  setProjects(projects) { this.projects = projects; this.render(); }
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
    const row = el('div', {
      class: 'session-row' + (isActive ? ' active' : '') + (isLive ? ' live' : ''),
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
      el('button', {
        class: 'session-delete', title: 'delete session',
        onclick: (e) => {
          e.stopPropagation();
          if (this.onDeleteSession) this.onDeleteSession({
            projectName, worktreeName, sessionId: session.sessionId,
            preview: liveLabel,
          });
        },
      }, '×'),
    );
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

  _worktreeNode({ project, wt, liveInstances }) {
    const head = el('div', { class: 'worktree-row' },
      el('span', { class: 'worktree-name', title: `${wt.branch}\nfrom ${wt.baseBranch} @ ${wt.baseSha?.slice(0, 12) ?? '?'}` },
        wt.worktreeName.replace(`${project.name}_worktree_`, ''),
      ),
    );
    const status = wt.mergeStatus;
    if (status && status.ahead > 0) {
      const label = status.behind > 0
        ? `↑${status.ahead} ↓${status.behind}`
        : `↑${status.ahead}`;
      const title = status.behind > 0
        ? `${status.ahead} commit(s) ahead of ${wt.baseBranch}, ${status.behind} behind — rebase, then fast-forward`
        : `${status.ahead} commit(s) ahead of ${wt.baseBranch} — fast-forward parent to land them`;
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

    for (const p of this.projects) {
      const directs = directByProject.get(p.name) ?? [];
      const worktrees = Array.isArray(p.worktrees) ? p.worktrees : [];
      const li = el('li', {});
      li.appendChild(el('div', { class: 'project-row' },
        el('span', { class: 'project-name' }, p.name),
        el('button', {
          class: 'add-instance', title: 'new session',
          onclick: () => this.onCreateInstanceClick(p.name),
        }, '+'),
        el('button', {
          class: 'delete-project', title: 'delete project',
          onclick: (e) => { e.stopPropagation(); this.onDeleteProject(p); },
        }, '×'),
      ));

      const sessionsNode = this._sessionsNode({
        project: p,
        liveInstances: directs,
        summary: p.sessions,
      });
      if (sessionsNode) li.appendChild(sessionsNode);
      else if (worktrees.length === 0) {
        // Project with neither sessions nor worktrees — show a tiny
        // "no sessions yet" hint to make the "+" button discoverable.
        li.appendChild(el('div', { class: 'empty-project-hint' }, 'no sessions yet — click + to start'));
      }

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

      this.list.appendChild(li);
    }
  }
}
