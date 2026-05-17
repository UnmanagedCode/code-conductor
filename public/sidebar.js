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

export class Sidebar {
  constructor({
    rootList, onSelectInstance, onCreateInstanceClick,
    onRemoveWorktree, onDeleteProject, onResumeSession, onLoadSessions,
  }) {
    this.list = rootList;
    this.onSelectInstance = onSelectInstance;
    this.onCreateInstanceClick = onCreateInstanceClick;
    this.onRemoveWorktree = onRemoveWorktree;
    this.onDeleteProject = onDeleteProject;
    this.onResumeSession = onResumeSession;
    this.onLoadSessions = onLoadSessions;
    this.projects = [];
    this.instances = [];
    this.activeInstanceId = null;
    // Track which worktree / sessions groups have been expanded so a
    // re-render doesn't slam them shut every time the instance list
    // changes.
    this.expandedWorktrees = new Set();   // key: projectName
    this.expandedSessions = new Set();    // key: `${projectName}` or `${projectName}:${worktreeName}`
    // Cached lazy-loaded session lists keyed the same way.
    this.sessionsCache = new Map();       // key → array
  }

  setProjects(projects) { this.projects = projects; this.render(); }
  setInstances(instances) { this.instances = instances; this.render(); }
  setActive(id) { this.activeInstanceId = id; this.render(); }

  _instanceRow(inst) {
    const sessionLabel = (inst.sessionId ?? inst.id).slice(0, 8);
    return el('div', {
      class: 'instance-row' + (inst.id === this.activeInstanceId ? ' active' : ''),
      onclick: () => this.onSelectInstance(inst.id),
    },
      el('span', { class: `dot ${inst.status}`, title: inst.status }),
      el('span', { class: 'instance-name', title: inst.sessionId ?? inst.id }, sessionLabel),
    );
  }

  _sessionsNode(project, { worktreeName = null, summary } = {}) {
    if (!summary || summary.count === 0) return null;
    const key = worktreeName ? `${project.name}:${worktreeName}` : project.name;
    const det = el('details', { class: 'sessions-group' });
    if (this.expandedSessions.has(key)) det.setAttribute('open', '');
    const lastLabel = formatAgo(summary.lastMtime);
    const summaryEl = el('summary', { class: 'sessions-summary' },
      `Sessions (${summary.count}) · last ${lastLabel}`);
    const listEl = el('ul', { class: 'sessions-list' });
    det.appendChild(summaryEl);
    det.appendChild(listEl);

    const renderList = (sessions) => {
      listEl.innerHTML = '';
      if (!sessions || sessions.length === 0) {
        listEl.appendChild(el('li', { class: 'sessions-empty' }, 'no sessions'));
        return;
      }
      for (const s of sessions) {
        const preview = (s.firstPrompt ?? '').slice(0, 80).replace(/\s+/g, ' ').trim();
        const row = el('div', {
          class: 'session-row', title: `${s.sessionId}\n${preview}`,
          onclick: () => {
            if (this.onResumeSession) this.onResumeSession({
              projectName: project.name,
              worktreeName,
              sessionId: s.sessionId,
            });
          },
        },
          el('span', { class: 'session-ago' }, formatAgo(s.mtime)),
          el('span', { class: 'session-preview' }, preview || `${s.sessionId.slice(0, 8)}…`),
        );
        listEl.appendChild(el('li', {}, row));
      }
    };

    // Lazy-load on first expand; populate from cache on subsequent
    // expands so re-renders don't refetch every time.
    det.addEventListener('toggle', async () => {
      if (det.open) {
        this.expandedSessions.add(key);
        const cached = this.sessionsCache.get(key);
        if (cached) {
          renderList(cached);
        } else {
          listEl.innerHTML = '';
          listEl.appendChild(el('li', { class: 'sessions-empty' }, 'loading…'));
          try {
            const sessions = this.onLoadSessions
              ? await this.onLoadSessions(project.name, worktreeName)
              : [];
            this.sessionsCache.set(key, sessions);
            renderList(sessions);
          } catch (e) {
            listEl.innerHTML = '';
            listEl.appendChild(el('li', { class: 'sessions-empty' }, `failed: ${e.message}`));
          }
        }
      } else {
        this.expandedSessions.delete(key);
      }
    });

    // If already cached from a prior expand, render immediately so the
    // post-render <details> shows fresh content too.
    const cached = this.sessionsCache.get(key);
    if (cached) renderList(cached);

    return det;
  }

  _worktreeNode(project, wt, attachedInstances) {
    const head = el('div', { class: 'worktree-row' },
      el('span', { class: 'worktree-name', title: `${wt.branch}\nfrom ${wt.baseBranch} @ ${wt.baseSha?.slice(0, 12) ?? '?'}` },
        wt.worktreeName.replace(`${project.name}_worktree_`, ''),
      ),
      el('span', { class: 'worktree-base' }, `← ${wt.baseBranch}`),
      el('button', {
        class: 'wt-spawn', title: 'spawn agent into this worktree',
        onclick: (e) => { e.stopPropagation(); this.onCreateInstanceClick(project.name, { worktreeName: wt.worktreeName }); },
      }, '+'),
      el('button', {
        class: 'wt-remove', title: 'remove worktree',
        onclick: (e) => { e.stopPropagation(); this.onRemoveWorktree(project.name, wt.worktreeName); },
      }, '×'),
    );
    const instUl = el('ul', { class: 'instance-list' });
    for (const inst of attachedInstances) {
      instUl.appendChild(el('li', {}, this._instanceRow(inst)));
    }
    const sessions = this._sessionsNode(project, {
      worktreeName: wt.worktreeName,
      summary: wt.sessions,
    });
    return el('li', { class: 'worktree-item' }, head, instUl, sessions);
  }

  render() {
    // Bucket instances by (project, worktree?) so worktree-attached
    // instances render under their worktree row instead of the project's
    // top-level list.
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
          class: 'add-instance', title: 'new instance',
          onclick: () => this.onCreateInstanceClick(p.name),
        }, '+'),
        el('button', {
          class: 'delete-project', title: 'delete project',
          onclick: (e) => { e.stopPropagation(); this.onDeleteProject(p); },
        }, '×'),
      ));

      const ul = el('ul', { class: 'instance-list' });
      for (const inst of directs) ul.appendChild(el('li', {}, this._instanceRow(inst)));
      if (directs.length === 0 && worktrees.length === 0) {
        ul.appendChild(el('li', {},
          el('div', { class: 'instance-row', style: 'opacity:.5; cursor:default' },
            el('span', { class: 'instance-name' }, 'no instances'))));
      }
      li.appendChild(ul);

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
          wtUl.appendChild(this._worktreeNode(p, wt, attached));
        }
        det.appendChild(wtUl);
        li.appendChild(det);
      }

      const sessionsNode = this._sessionsNode(p, { summary: p.sessions });
      if (sessionsNode) li.appendChild(sessionsNode);

      this.list.appendChild(li);
    }
  }
}
