import { el } from './blocks.js';
import { formatAutoResumeTime } from './usage.js';

// Compact "X min/hr/days ago" formatter. Used by the Sessions subnode
// so the user can see at-a-glance which sessions are recent enough to
// be worth resuming.
export function formatAgo(ms) {
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
  // Seed instanceTemp from the durable on-disk `temp` flag (set by
  // listSessionsForCwd from temp-sessions.json) so an exited/re-discovered
  // temp session classifies correctly even with no live instance. The live
  // overlay below overrides this with the authoritative inst.temp when an
  // instance exists (so a just-promoted session de-temps immediately).
  const byId = new Map((onDisk ?? []).map(s => [s.sessionId, { ...s, instanceTemp: !!s.temp }]));
  for (const inst of liveInstances) {
    if (!inst.sessionId) continue;
    if (byId.has(inst.sessionId)) {
      const row = byId.get(inst.sessionId);
      row.instanceId = inst.id;
      row.instanceStatus = inst.status;
      row.instanceDisplayStatus = inst.displayStatus;
      row.instanceMode = inst.mode;
      row.instanceTemp = !!inst.temp;
      row.instanceHasIdleSubscriber = !!inst.hasIdleSubscriber;
      row.autoResumeAt = inst.autoResumeAt ?? null;
      row.queuedCount = inst.queuedCount ?? 0;
      // Conducted is durable on-disk metadata (row.conducted may already
      // be set from the API). A live conducted instance is authoritative;
      // OR the two so a UI-resumed conducted session stays grouped.
      row.conducted = !!inst.conducted || !!row.conducted;
      // Live instance summary carries the freshest title (set via the
      // ⋮ Rename action without a refetch). Prefer it over a stale
      // on-disk-list entry from the last /api/projects round-trip.
      if (inst.title) row.title = inst.title;
    } else {
      byId.set(inst.sessionId, {
        sessionId: inst.sessionId,
        firstPrompt: inst.firstPrompt ?? null,
        title: inst.title ?? null,
        // A live temp instance's jsonl is excluded from `onDisk` for as long
        // as it's alive (see tempSessionIdsForCwd), so it lands in this
        // synthetic branch on EVERY render, not just its first. Both fallbacks
        // MUST be stable across renders: a per-render Date.now() here would
        // re-stamp mtime to "now" on every render — freezing the "ago" label at
        // ~0s and, worse, jumping every such row in lockstep to the exact
        // timestamp of whichever session most recently completed a turn (its
        // turn_end triggers the render). inst.lastResponseAt (set once per
        // completed turn, same field header.js uses) covers post-first-turn;
        // inst.createdAt (stamped once at spawn) covers the pre-first-turn case
        // so a brand-new/idle session shows its true "created Xs ago" age.
        mtime: inst.lastResponseAt ?? inst.createdAt,
        size: 0,
        instanceId: inst.id,
        instanceStatus: inst.status,
        instanceDisplayStatus: inst.displayStatus,
        instanceMode: inst.mode,
        instanceTemp: !!inst.temp,
        instanceHasIdleSubscriber: !!inst.hasIdleSubscriber,
        autoResumeAt: inst.autoResumeAt ?? null,
        queuedCount: inst.queuedCount ?? 0,
        conducted: !!inst.conducted,
        synthetic: true,
      });
    }
  }
  const out = [...byId.values()];
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// localStorage key for the set of expanded workspace headers. Sessions
// and worktree collapse state is session-local, but workspaces are
// higher-level navigation — surviving a refresh is worth the extra
// persistence.
const WORKSPACES_EXPANDED_STORAGE_KEY = 'code-conductor:workspaces-expanded';

function loadExpandedWorkspaces() {
  try {
    const raw = localStorage.getItem(WORKSPACES_EXPANDED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter(s => typeof s === 'string'));
  } catch {
    return new Set();
  }
}
function saveExpandedWorkspaces(set) {
  try {
    if (set.size === 0) localStorage.removeItem(WORKSPACES_EXPANDED_STORAGE_KEY);
    else localStorage.setItem(WORKSPACES_EXPANDED_STORAGE_KEY, JSON.stringify([...set]));
  } catch { /* private mode / quota — best-effort */ }
}

// Keyed in-place reconcile of an element's children against an ordered
// `keys` list. `makeOrUpdate(key, existingNode|null)` returns the node to
// place for each key — the SAME node when updating (which is what preserves
// <details> open state, listeners, focus, and scroll), a fresh node when
// creating. Nodes are moved into `keys` order with the minimal number of
// insertBefore calls, and keyed children absent from `keys` are removed.
//
// Contract: every child of a reconciled parent MUST carry a data-key (this
// function stamps it), including placeholders — an unkeyed child is invisible
// to the map and so is never repositioned or cleaned up. This is the single
// primitive that replaces the old `innerHTML = ''` full teardown; because the
// scroll container (#sidebar-body) never sees its content emptied, scroll
// position and open/collapse state survive every refresh.
function reconcileChildren(parent, keys, makeOrUpdate) {
  const existing = new Map();
  for (const child of parent.children) {
    const k = child.dataset && child.dataset.key;
    if (k != null) existing.set(k, child);
  }
  const desired = new Set(keys);
  let cursor = parent.firstElementChild;
  for (const key of keys) {
    const node = makeOrUpdate(key, existing.get(key) ?? null);
    node.dataset.key = key;
    if (node === cursor) {
      cursor = cursor.nextElementSibling; // already in place — advance past it
    } else {
      parent.insertBefore(node, cursor);  // insertBefore(node, null) === append
    }
  }
  for (const [k, node] of existing) {
    if (!desired.has(k)) node.remove();
  }
}

export class Sidebar {
  constructor({
    rootList, onSelectInstance, onCreateInstanceClick,
    onRemoveWorktree, onDeleteProject, onResumeSession, onLoadSessions,
    onDeleteSession, onEditWorkspace, onPromoteSession,
    onReviewWorktree,
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
    this.onPromoteSession = onPromoteSession;
    this.onReviewWorktree = onReviewWorktree;
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
    // Workspace containers default-collapsed and persist their expanded
    // state in localStorage so a page refresh keeps the layout stable.
    this.expandedWorkspaces = loadExpandedWorkspaces(); // key: workspace name
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
    this.conductSessionCount = 0;
    this.conductSessionLastMtime = 0;
  }

  setProjects(projects) { this.projects = projects; this.render(); }
  setWorkspaces(names) {
    const arr = Array.isArray(names) ? names.filter(n => typeof n === 'string') : [];
    this.workspaces = [...new Set(arr)];
    this.render();
  }
  setUnread(map) { this.unreadBySessionId = map ?? new Map(); this.render(); }
  setConductSessions({ count = 0, lastMtime = 0 } = {}) {
    this.conductSessionCount = count;
    this.conductSessionLastMtime = lastMtime;
    this.render();
  }
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

  // Refreshes every live "Xs/Xm/Xh ago" label in place from its cached
  // data-mtime, without rebuilding the DOM (unlike render(), this doesn't
  // disturb <details> open/collapsed state or scroll position). Driven by
  // a timer in app.js — mirrors header.js's tickIdleAgo(), which solves the
  // identical "formatAgo is a snapshot, nothing re-ticks it" problem for the
  // turn-indicator's idle label.
  tickAgo() {
    for (const node of this.list.querySelectorAll('.session-ago[data-mtime]')) {
      node.textContent = formatAgo(Number(node.dataset.mtime));
    }
    for (const node of this.list.querySelectorAll('.sessions-last-ago[data-mtime]')) {
      node.textContent = ` · last ${formatAgo(Number(node.dataset.mtime))}`;
    }
  }

  // Visible session count for a subnode = on-disk count + live instances
  // whose sessionId isn't already on disk. Shared by the parent (to decide
  // whether the Sessions subnode exists at all) and the subnode's own
  // summary update, so both agree within a single render.
  _sessionsTotal({ project, worktreeName, liveInstances, summary }) {
    const key = worktreeName ? `${project.name}:${worktreeName}` : project.name;
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
    return onDiskCount + extra;
  }

  // Create-or-update one session row (an <li> wrapping the .session-row div).
  // Built once with create-only click/delete/promote handlers that read a
  // mutable `holder` so they always see the freshest session (its instanceId
  // changes across crash+resume); every re-render patches the volatile bits
  // (status dot, active/live/unread classes, ago label, badges) in place. The
  // conditional badges/buttons are themselves keyed-reconciled so they slot in
  // at the right position without disturbing the always-present children.
  _sessionRow(existing, { session, projectName, worktreeName }) {
    let li = existing, row, holder;
    if (!li) {
      li = el('li', {});
      holder = { session, projectName, worktreeName };
      row = el('div', {
        class: 'session-row',
        onclick: () => {
          const s = holder.session;
          if (s.instanceId) this.onSelectInstance(s.instanceId);
          else if (this.onResumeSession) this.onResumeSession({
            projectName: holder.projectName, worktreeName: holder.worktreeName, sessionId: s.sessionId,
          });
        },
      });
      li.appendChild(row);
      li._holder = holder;
      li._row = row;
    } else {
      holder = li._holder;
      row = li._row;
    }
    holder.session = session;
    holder.projectName = projectName;
    holder.worktreeName = worktreeName;

    const customTitle = (session.title ?? '').trim();
    const preview = (session.firstPrompt ?? '').slice(0, 80).replace(/\s+/g, ' ').trim();
    const liveLabel = customTitle || preview || (session.synthetic ? '(new session)' : `${session.sessionId.slice(0, 8)}…`);
    li._liveLabel = liveLabel;
    const isLive = !!session.instanceId;
    const status = session.instanceDisplayStatus ?? session.instanceStatus ?? 'offline';
    const isActive = session.instanceId === this.activeInstanceId;
    const unread = this.unreadBySessionId.get(session.sessionId) ?? 0;
    const tooltipParts = [session.sessionId];
    if (customTitle && preview) tooltipParts.push(preview);

    row.className = 'session-row' + (isActive ? ' active' : '') + (isLive ? ' live' : '') + (unread > 0 ? ' has-unread' : '') + (session.instanceTemp ? ' temp' : '') + (session.conducted ? ' conducted' : '') + (session.archived ? ' archived' : '') + (customTitle ? ' has-title' : '');
    row.title = tooltipParts.join('\n');

    const resumeLabel = session.autoResumeAt ? formatAutoResumeTime(session.autoResumeAt) : null;
    const showPromote = session.instanceTemp && session.instanceId;
    const keys = ['dot', 'ago', 'preview'];
    if (unread > 0) keys.push('unread');
    if (resumeLabel) keys.push('resume');
    if (showPromote) keys.push('promote');
    keys.push('delete');
    reconcileChildren(row, keys, (k, ex) => {
      if (k === 'dot') {
        const dot = ex ?? el('span', { class: 'dot' });
        dot.className = `dot ${status}${status === 'idle' && session.instanceHasIdleSubscriber ? ' subscribed' : ''}`;
        dot.title = status;
        return dot;
      }
      if (k === 'ago') {
        const ago = ex ?? el('span', { class: 'session-ago' });
        ago.textContent = formatAgo(session.mtime);
        if (session.mtime) ago.dataset.mtime = String(session.mtime);
        else delete ago.dataset.mtime;
        return ago;
      }
      if (k === 'preview') {
        const pv = ex ?? el('span', { class: 'session-preview' });
        pv.textContent = liveLabel;
        return pv;
      }
      if (k === 'unread') {
        const b = ex ?? el('span', { class: 'session-unread' });
        b.textContent = String(unread);
        b.title = `${unread} new turn${unread === 1 ? '' : 's'} since you last viewed this session`;
        return b;
      }
      if (k === 'resume') {
        const n = session.queuedCount || 0;
        const b = ex ?? el('span', { class: 'session-resume-badge' });
        b.textContent = resumeLabel + (n > 0 ? ` · ${n} queued` : '');
        b.title = n > 0
          ? `auto-stopped on overage — ${n} queued; will resume when the window resets`
          : 'auto-stopped on overage — will resume when the rate-limit window resets';
        return b;
      }
      if (k === 'promote') {
        // Live temp instance → promote button to the left of ×. Always
        // visible (no opacity:0 hover) so mobile users can tap it.
        return ex ?? el('button', {
          class: 'session-promote', title: 'promote to normal session',
          onclick: (e) => {
            e.stopPropagation();
            const s = holder.session;
            if (this.onPromoteSession) this.onPromoteSession({
              projectName: holder.projectName, instanceId: s.instanceId, preview: li._liveLabel,
            });
          },
        }, '↑');
      }
      // delete
      return ex ?? el('button', {
        class: 'session-delete', title: 'archive session (keeps history)',
        onclick: (e) => {
          e.stopPropagation();
          const s = holder.session;
          if (this.onDeleteSession) this.onDeleteSession({
            projectName: holder.projectName, worktreeName: holder.worktreeName, sessionId: s.sessionId,
            preview: li._liveLabel, synthetic: s.synthetic,
          });
        },
      }, '×');
    });
    return li;
  }

  // Sessions subnode — a STABLE <details> whose open state, toggle listener
  // and lazy-loaded list survive across renders. Fresh live data flows in via
  // det._update({liveInstances, summary}); the on-disk half is lazy-loaded the
  // first time the subnode is expanded and cached. Rows are keyed-reconciled by
  // sessionId (with `— temp —` / `— conducted —` separators) so status dots
  // mutate in place instead of tearing the list down.
  _sessionsNode(existing, { project, worktreeName, liveInstances, summary }) {
    let det = existing;
    if (!det) {
      const key = worktreeName ? `${project.name}:${worktreeName}` : project.name;
      det = el('details', { class: 'sessions-group' });
      if (!this.collapsedSessions.has(key)) det.setAttribute('open', '');
      // Summary text lives in its own Text node so det._update can patch it
      // via nodeValue without clobbering the appended `sessions-last-ago`
      // span that tickAgo() targets.
      const summaryEl = el('summary', { class: 'sessions-summary' });
      const summaryText = document.createTextNode('');
      summaryEl.appendChild(summaryText);
      const listEl = el('ul', { class: 'sessions-list' });
      det.appendChild(summaryEl);
      det.appendChild(listEl);

      det._key = key;
      det._summaryEl = summaryEl;
      det._summaryText = summaryText;
      det._listEl = listEl;
      det._lastAgoSpan = null;
      det._live = { liveInstances, summary };
      det._loading = false;

      const setStatus = (text) => reconcileChildren(listEl, ['status'], (k, ex) => {
        const li = ex ?? el('li', { class: 'sessions-empty' });
        li.textContent = text;
        return li;
      });

      det._renderList = (onDisk) => {
        const merged = mergeLive(onDisk, det._live.liveInstances);
        if (merged.length === 0) {
          reconcileChildren(listEl, ['empty'], (k, ex) => ex ?? el('li', { class: 'sessions-empty' }, 'no sessions'));
          return;
        }
        // Two pinned sections below the normal list, each under a dim
        // divider, so the user can see them at a glance without losing the
        // mtime sort over the normal sessions above:
        //   — temp —       live temp sessions that are NOT conducted
        //   — conducted —  sessions spawned via the MCP spawn_instance tool
        // Precedence: conducted wins over temp for grouping; the conducted
        // section is appended last so temp-only ordering is unchanged.
        // Archived sessions never appear in the sidebar (managed solely from
        // Settings → Archived) — excluded from every group.
        const conductedRows = merged.filter(s => !s.archived && s.conducted);
        const temps = merged.filter(s => !s.archived && !s.conducted && s.instanceTemp);
        const normal = merged.filter(s => !s.archived && !s.conducted && !s.instanceTemp);
        const keys = [];
        const byKey = new Map();
        const add = (rows) => { for (const s of rows) { const k = `sess:${s.sessionId}`; keys.push(k); byKey.set(k, s); } };
        add(normal);
        if (temps.length > 0) { keys.push('sep:temp'); add(temps); }
        if (conductedRows.length > 0) { keys.push('sep:conducted'); add(conductedRows); }
        reconcileChildren(listEl, keys, (k, ex) => {
          if (k === 'sep:temp') return ex ?? el('li', { class: 'sessions-separator' }, '— temp —');
          if (k === 'sep:conducted') return ex ?? el('li', { class: 'sessions-separator' }, '— conducted —');
          return this._sessionRow(ex, { session: byKey.get(k), projectName: project.name, worktreeName });
        });
      };

      det._loadAndRender = async () => {
        if (det._loading) return; // coalesce refreshes landing mid-fetch
        det._loading = true;
        // Only show a "loading…" placeholder on a COLD subnode (nothing
        // rendered yet). If stale rows are already showing — e.g. a cache
        // invalidated by a turn→idle transition — keep them in place until the
        // reload resolves, so the list reconciles smoothly instead of flashing
        // "loading…" on every turn end.
        if (!listEl.querySelector('[data-key^="sess:"]')) setStatus('loading…');
        try {
          const onDisk = this.onLoadSessions ? await this.onLoadSessions(project.name, worktreeName) : [];
          this.sessionsCache.set(key, onDisk);
          if (det.isConnected) det._renderList(onDisk);
        } catch (e) {
          if (det.isConnected) setStatus(`failed: ${e.message}`);
        } finally {
          det._loading = false;
        }
      };

      det._update = ({ liveInstances, summary }) => {
        det._live = { liveInstances, summary };
        const total = this._sessionsTotal({ project, worktreeName, liveInstances, summary });
        const liveSummary = liveInstances.length > 0 ? ` · ${liveInstances.length} live` : '';
        det._summaryText.nodeValue = `Sessions (${total})${liveSummary}`;
        if (summary?.lastMtime) {
          if (!det._lastAgoSpan) {
            det._lastAgoSpan = el('span', { class: 'sessions-last-ago' });
            det._summaryEl.appendChild(det._lastAgoSpan);
          }
          det._lastAgoSpan.textContent = ` · last ${formatAgo(summary.lastMtime)}`;
          det._lastAgoSpan.dataset.mtime = String(summary.lastMtime);
        } else if (det._lastAgoSpan) {
          det._lastAgoSpan.remove();
          det._lastAgoSpan = null;
        }
        // Refresh the list against the freshest live overlay. A present cache
        // renders immediately; a missing cache on an open subnode kicks off
        // the lazy load (the "free reload" the old full-rebuild gave us — a
        // cache cleared by setInstances is repopulated here). A closed subnode
        // with no cache stays empty until the user expands it.
        const cached = this.sessionsCache.get(key);
        if (cached) det._renderList(cached);
        else if (det.open) det._loadAndRender();
      };

      det.addEventListener('toggle', () => {
        if (det.open) {
          this.collapsedSessions.delete(key);
          const cached = this.sessionsCache.get(key);
          if (cached) det._renderList(cached);
          else det._loadAndRender();
        } else {
          this.collapsedSessions.add(key);
        }
      });
    }

    det._update({ liveInstances, summary });
    return det;
  }

  // Create-or-update the head row of a worktree item (buttons + name + base +
  // the merge-status pill). Buttons capture stable strings, so they're built
  // create-only; the pill is inserted/removed at its fixed position (between
  // name and base) on update.
  _worktreeHead(existing, { project: p, wt }) {
    let head = existing;
    if (!head) {
      head = el('div', { class: 'worktree-row' });
      head.appendChild(el('button', {
        class: 'commit-log', title: 'commit history',
        onclick: (e) => { e.stopPropagation(); this.onShowCommits?.(wt.worktreeName); },
      }, '≡'));
      const nameSpan = el('span', { class: 'worktree-name' });
      head.appendChild(nameSpan);
      const baseSpan = el('span', { class: 'worktree-base' });
      head.appendChild(baseSpan);
      head.appendChild(el('button', {
        class: 'wt-review', title: 'review changes',
        onclick: (e) => { e.stopPropagation(); this.onReviewWorktree?.(p.name, wt.worktreeName); },
      }, '±'));
      head.appendChild(el('button', {
        class: 'wt-spawn', title: 'new session in this worktree',
        onclick: (e) => { e.stopPropagation(); this.onCreateInstanceClick(p.name, { worktreeName: wt.worktreeName }); },
      }, '+'));
      head.appendChild(el('button', {
        class: 'wt-remove', title: 'remove worktree',
        onclick: (e) => { e.stopPropagation(); this.onRemoveWorktree(p.name, wt.worktreeName); },
      }, '×'));
      head._nameSpan = nameSpan;
      head._baseSpan = baseSpan;
      head._pill = el('span', { class: 'wt-unmerged' });
    }
    const { _nameSpan: nameSpan, _baseSpan: baseSpan, _pill: pill } = head;
    nameSpan.textContent = wt.worktreeName.replace(`${p.name}_worktree_`, '');
    nameSpan.title = `${wt.branch}\nfrom ${wt.baseBranch} @ ${wt.baseSha?.slice(0, 12) ?? '?'}`;
    baseSpan.textContent = `← ${wt.baseBranch}`;
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
      pill.textContent = label; pill.title = title;
      if (!pill.isConnected) nameSpan.after(pill);
    } else if (pill.isConnected) {
      pill.remove();
    }
    return head;
  }

  // Create-or-update one worktree item (<li> = head + optional Sessions
  // subnode). The Sessions subnode only exists when its total > 0, reconciled
  // as a keyed child so it appears/disappears without rebuilding the head.
  _worktreeNode(existing, { project: p, wt, liveInstances }) {
    const li = existing ?? el('li', { class: 'worktree-item' });
    const showSessions = this._sessionsTotal({ project: p, worktreeName: wt.worktreeName, liveInstances, summary: wt.sessions }) > 0;
    const keys = ['head'];
    if (showSessions) keys.push('sessions');
    reconcileChildren(li, keys, (ck, ex) => {
      if (ck === 'head') return this._worktreeHead(ex, { project: p, wt });
      return this._sessionsNode(ex, { project: p, worktreeName: wt.worktreeName, liveInstances, summary: wt.sessions });
    });
    return li;
  }

  // Create-or-update the Worktrees subnode (stable <details>) — count in the
  // summary is patched, and the worktree items are keyed-reconciled by name.
  _worktreeGroup(existing, { project: p, worktrees, byWorktree }) {
    let det = existing;
    if (!det) {
      det = el('details', { class: 'worktree-group' });
      if (this.expandedWorktrees.has(p.name)) det.setAttribute('open', '');
      det.addEventListener('toggle', () => {
        if (det.open) this.expandedWorktrees.add(p.name);
        else this.expandedWorktrees.delete(p.name);
      });
      const summaryEl = el('summary', { class: 'worktree-summary' });
      const wtUl = el('ul', { class: 'worktree-list' });
      det.appendChild(summaryEl);
      det.appendChild(wtUl);
      det._summaryEl = summaryEl;
      det._wtUl = wtUl;
    }
    det._summaryEl.textContent = `Worktrees (${worktrees.length})`;
    const wtByName = new Map(worktrees.map(wt => [wt.worktreeName, wt]));
    const keys = worktrees.map(wt => `wt:${wt.worktreeName}`);
    reconcileChildren(det._wtUl, keys, (k, ex) => {
      const wt = wtByName.get(k.slice(3));
      const attached = byWorktree.get(`${p.name}:${wt.worktreeName}`) ?? [];
      return this._worktreeNode(ex, { project: p, wt, liveInstances: attached });
    });
    return det;
  }

  // Create-or-update the project row (name + merge-status pill + action
  // buttons). Buttons are create-only; delete-project reads a mutable holder
  // so it always deletes the current project object. The pill is inserted /
  // removed at its fixed position (between name and the action buttons).
  _projectRow(existing, { project: p, isConduct }) {
    let row = existing;
    if (!row) {
      row = el('div', { class: 'project-row' + (isConduct ? ' project-row-conduct' : '') });
      // Commit-log button goes first (left of the name) for git projects.
      if (!isConduct && p.isGitRepo) {
        row.appendChild(el('button', {
          class: 'commit-log', title: 'commit history',
          onclick: (e) => { e.stopPropagation(); this.onShowCommits?.(p.name); },
        }, '≡'));
      }
      const nameSpan = el('span', { class: 'project-name' }, isConduct ? '🎼 Conduct' : p.name);
      row.appendChild(nameSpan);
      const holder = { p };
      // The synthetic Conduct row is read-only: no quick-spawn, no
      // new-session button, no delete. Spawning is via the top-level 🎼
      // button; deletion is blocked server-side.
      if (!isConduct) {
        row.appendChild(el('button', {
          class: 'add-instance', title: 'new session',
          onclick: () => this.onCreateInstanceClick(p.name),
        }, '+'));
        row.appendChild(el('button', {
          class: 'delete-project', title: 'delete project',
          onclick: (e) => { e.stopPropagation(); this.onDeleteProject(holder.p); },
        }, '×'));
      }
      row._nameSpan = nameSpan;
      row._pill = el('span', { class: 'wt-unmerged' });
      row._holder = holder;
    }
    row._holder.p = p;
    const { _nameSpan: nameSpan, _pill: pill } = row;
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
      pill.textContent = label; pill.title = title;
      if (!pill.isConnected) nameSpan.after(pill);
    } else if (pill.isConnected) {
      pill.remove();
    }
    return row;
  }

  // Create-or-update a project's list item (project row + optional Sessions
  // subnode + optional Worktrees subnode). Shared between top-level unassigned
  // items, workspace-nested items, and the synthetic .conduct row. The <li>'s
  // own children are keyed-reconciled so a Sessions subnode can appear/vanish
  // (between the row and the Worktrees group) without a teardown.
  _projectItem(existing, { project: p, directByProject, byWorktree }) {
    const isConduct = !!p.isConduct;
    const li = existing ?? el('li', { class: isConduct ? 'project-conduct' : undefined });
    const allDirects = directByProject.get(p.name) ?? [];
    const worktrees = Array.isArray(p.worktrees) ? p.worktrees : [];
    const showSessions = this._sessionsTotal({ project: p, worktreeName: null, liveInstances: allDirects, summary: p.sessions }) > 0;

    const keys = ['row'];
    if (showSessions) keys.push('sessions');
    // Project with neither sessions nor worktrees — show a tiny hint so the
    // "+" button is discoverable.
    else if (worktrees.length === 0) keys.push('hint');
    if (worktrees.length > 0) keys.push('worktrees');

    reconcileChildren(li, keys, (ckey, ex) => {
      if (ckey === 'row') return this._projectRow(ex, { project: p, isConduct });
      if (ckey === 'sessions') return this._sessionsNode(ex, { project: p, worktreeName: null, liveInstances: allDirects, summary: p.sessions });
      if (ckey === 'hint') return ex ?? el('div', { class: 'empty-project-hint' }, 'no sessions yet — tap + to start');
      return this._worktreeGroup(ex, { project: p, worktrees, byWorktree });
    });
    return li;
  }

  // Create-or-update a workspace container (<li> → stable <details>). Toggle
  // listener + edit button are create-only; the member project items are
  // keyed-reconciled by name (with an `empty` placeholder when the workspace
  // has no members).
  _workspaceItem(existing, { name, members, directByProject, byWorktree }) {
    let li = existing;
    if (!li) {
      li = el('li', { class: 'project-workspace-item' });
      const det = el('details', { class: 'project-workspace' });
      if (this.expandedWorkspaces.has(name)) det.setAttribute('open', '');
      det.addEventListener('toggle', () => {
        if (det.open) this.expandedWorkspaces.add(name);
        else this.expandedWorkspaces.delete(name);
        saveExpandedWorkspaces(this.expandedWorkspaces);
      });
      const countSpan = el('span', { class: 'project-workspace-count' }, '');
      const summary = el('summary', { class: 'project-workspace-summary' },
        el('span', { class: 'project-workspace-name' }, name),
        countSpan,
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
      det.appendChild(ul);
      li.appendChild(det);
      li._ul = ul;
      li._countSpan = countSpan;
    }
    li._countSpan.textContent = `(${members.length})`;
    if (members.length === 0) {
      reconcileChildren(li._ul, ['empty'], (k, ex) => ex ?? el('li', { class: 'workspace-empty' },
        'no projects in this workspace — tap ✎ to add'));
    } else {
      const byName = new Map(members.map(p => [p.name, p]));
      const keys = members.map(p => `proj:${p.name}`);
      reconcileChildren(li._ul, keys, (k, ex) => this._projectItem(ex, {
        project: byName.get(k.slice(5)), directByProject, byWorktree,
      }));
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

    // Synthetic .conduct row — only appears while a Conduct instance is live
    // (or on-disk conduct sessions exist). The project itself is hidden from
    // listProjects() by the dot-prefix filter, so without this synthesis a
    // conductor session would have no parent row and be unreachable.
    const conductInstances = this.instances.filter(i => i.project === '.conduct');
    const showConduct = conductInstances.length > 0 || this.conductSessionCount > 0;
    if (showConduct) directByProject.set('.conduct', conductInstances);
    const makeConduct = (existing) => this._projectItem(existing, {
      project: {
        name: '.conduct',
        path: '(hidden)',
        workspace: null,
        isGitRepo: false,
        worktrees: [],
        sessions: { count: this.conductSessionCount, lastMtime: this.conductSessionLastMtime },
        mergeStatus: { ahead: null, behind: null, upstream: null },
        sessionIds: conductInstances.map(i => i.sessionId),
        isConduct: true,
      },
      directByProject, byWorktree,
    });

    if (this.projects.length === 0) {
      const keys = showConduct ? ['conduct'] : ['empty'];
      reconcileChildren(this.list, keys, (key, existing) => {
        if (key === 'conduct') return makeConduct(existing);
        return existing ?? el('li', { class: 'project-row' },
          el('span', { class: 'project-name' }, 'no projects yet'));
      });
      return;
    }

    // Split into workspace-assigned (rendered first, nested under <details>)
    // and unassigned (rendered flat underneath). Workspace order is
    // alphabetical. The set of rendered workspaces is the union of (registered
    // workspaces from GET /api/workspaces) and (workspaces referenced by any
    // project), so empty workspaces still appear.
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
    const unassignedByName = new Map(unassigned.map(p => [p.name, p]));

    const keys = [];
    if (showConduct) keys.push('conduct');
    for (const name of workspaceNames) keys.push(`ws:${name}`);
    for (const p of unassigned) keys.push(`proj:${p.name}`);

    reconcileChildren(this.list, keys, (key, existing) => {
      if (key === 'conduct') return makeConduct(existing);
      if (key.startsWith('ws:')) {
        const name = key.slice(3);
        return this._workspaceItem(existing, { name, members: byWorkspace.get(name), directByProject, byWorktree });
      }
      const name = key.slice(5); // proj:
      return this._projectItem(existing, { project: unassignedByName.get(name), directByProject, byWorktree });
    });
  }
}
