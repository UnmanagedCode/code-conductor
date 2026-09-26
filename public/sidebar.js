import { el } from './dom.js';
import { formatAutoResumeTime } from './usage.js';
import { conductorColor } from './conductorColor.js';
import {
  sessionFromInstance, deriveConductors, conductorTitle, workersOf, conductorProjects,
  ownersByPlace, worktreeOwnership, ownerLabel, stageText, isLiveStatus,
} from './conductors.js';
import { deriveStrip, isStripEmpty, entryReason, needsYouTitle } from './needsYou.js';

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
      row.instanceAwaitingWake = !!inst.awaitingWake;
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
      // Live-only: a disk row never carries an owner.
      row.ownerSessionId = inst.ownerSessionId ?? null;
    } else {
      // A live temp instance's jsonl is excluded from `onDisk` for as long
      // as it's alive (see tempSessionIdsForCwd), so it lands in this
      // synthetic branch on EVERY render, not just its first. Its lastActivity
      // fallbacks MUST be stable across renders: a per-render Date.now() would
      // re-stamp lastActivity to "now" on every render — freezing the "ago"
      // label at ~0s and, worse, jumping every such row in lockstep to the
      // exact timestamp of whichever session most recently completed a turn
      // (its turn_end triggers the render). inst.lastResponseAt (set once per
      // completed turn, same field header.js uses) covers post-first-turn;
      // inst.createdAt (stamped once at spawn) covers the pre-first-turn case
      // so a brand-new/idle session shows its true "created Xs ago" age.
      byId.set(inst.sessionId, sessionFromInstance(inst));
    }
  }
  const out = [...byId.values()];
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
}

// localStorage key for the set of expanded workspace headers. Sessions
// and worktree collapse state is session-local, but workspaces are
// higher-level navigation — surviving a refresh is worth the extra
// persistence.
const WORKSPACES_EXPANDED_STORAGE_KEY = 'code-conductor:workspaces-expanded';

// reconcileChildren key prefix of a Conductors-lens block; its sessionId follows.
const CONDUCTOR_KEY = 'conductor:';

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

// The needs-you strip's group headings, in display order.
const STRIP_HEADS = { waiting: 'Waiting on you', running: 'Running', finished: 'Finished' };

export class Sidebar {
  constructor({
    rootList, conductorList, filterRoot, stripRoot, onSelectInstance, onCreateInstanceClick,
    onRemoveWorktree, onDeleteProject, onResumeSession, onLoadSessions,
    onDeleteSession, onEditWorkspace, onPromoteSession,
    onReviewWorktree, onEditProjectRemote,
  }) {
    this.list = rootList;
    // The Conductors lens's list, the Projects lens's conductor filter and the
    // needs-you strip's slot (shown in both lenses). All optional: without
    // conductorList the Conductors render is skipped, without filterRoot the
    // filter stays off, without stripRoot the strip render is skipped.
    this.conductorList = conductorList ?? null;
    this.filterRoot = filterRoot ?? null;
    this.stripRoot = stripRoot ?? null;
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
    this.onEditProjectRemote = onEditProjectRemote;
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
    // stale (firstPrompt may have just appeared, lastActivity advanced, etc.).
    this._prevStatusById = new Map();
    // Per-sessionId count of turn_notifications that landed while the
    // user wasn't viewing this session. Driven from unread.js; cleared on
    // selectInstance. Keyed by sessionId so it survives crash + resume
    // (a new instance id for the same session).
    this.unreadBySessionId = new Map();
    // The `.conduct` disk rows (GET /api/projects/.conduct/sessions): the
    // conductors that are not live, for the Conductors *Inactive* group.
    this.conductRows = [];
    this.expandedConductors = new Set();    // key: conductor sessionId
    this.inactiveOpen = false;
    // Conductor filter: '' (all), 'hand' (hand-spawned only) or an owner
    // sessionId.
    this.filter = '';
    this._filterSelect = this.filterRoot?.querySelector('select') ?? null;
    if (this._filterSelect) {
      this._filterSelect.addEventListener('change', () => {
        this.filter = this._filterSelect.value;
        this.render();
      });
    }
    // Per-render derivations shared by the row builders (see render()).
    this._owners = new Map();
    this._conductors = { live: [], inactive: [] };
  }

  setProjects(projects) { this.projects = projects; this.render(); }
  setWorkspaces(names) {
    const arr = Array.isArray(names) ? names.filter(n => typeof n === 'string') : [];
    this.workspaces = [...new Set(arr)];
    this.render();
  }
  setUnread(map) { this.unreadBySessionId = map ?? new Map(); this.render(); }
  setConductSessions(rows) {
    this.conductRows = Array.isArray(rows) ? rows : [];
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
    // picks up the real firstPrompt / lastActivity in place of the synthetic
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
  // data-activity, without rebuilding the DOM (unlike render(), this doesn't
  // disturb <details> open/collapsed state or scroll position). Driven by
  // a timer in app.js — mirrors header.js's tickIdleAgo(), which solves the
  // identical "formatAgo is a snapshot, nothing re-ticks it" problem for the
  // turn-indicator's idle label.
  tickAgo() {
    for (const root of [this.list, this.conductorList]) {
      if (!root) continue;
      for (const node of root.querySelectorAll('.session-ago[data-activity]')) {
        node.textContent = formatAgo(Number(node.dataset.activity));
      }
    }
    for (const node of this.list.querySelectorAll('.sessions-last-ago[data-activity]')) {
      node.textContent = ` · last ${formatAgo(Number(node.dataset.activity))}`;
    }
  }

  // Whether a place (main checkout or worktree) holds a session Hand-spawned
  // only would list: a non-archived, non-conducted one on disk, or a live one
  // that is not conducted.
  _hasHandSession({ liveInstances, summary }) {
    return (summary?.handCount ?? 0) > 0 || liveInstances.some(i => !i.conducted);
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

  // The status dot shared by session rows and conductor rows. `awaitingWake` is
  // CALLER-side: this session is idle because it is waiting on a worker's
  // running turn, not because it is done. The accent modifier is the only thing
  // on the row that distinguishes those two, and it stays lit across a
  // heartbeat (a heartbeat reports without consuming the wake), so a conductor
  // whose worker is hung no longer reads as done. `awaitingUser` adds the
  // waiting-on-you ring over whatever fill the run state gives, on a live dot
  // only.
  _applyDot(dot, { status, awaitingWake, awaitingUser = null, awaitingUserSource = null }) {
    const awaiting = status === 'idle' && !!awaitingWake;
    const forYou = !!awaitingUser && status !== 'offline' && isLiveStatus(status);
    dot.className = `dot ${status}${awaiting ? ' awaiting' : ''}${forYou ? ' needs-you' : ''}`;
    dot.title = forYou ? needsYouTitle({ status, awaitingWake, awaitingUser, awaitingUserSource })
      : awaiting ? 'idle — waiting on a worker' : status;
    return dot;
  }

  // Mark (or unmark) a node as owned by a conductor: the `owned` class plus the
  // --owner-color the stylesheet draws the bar in. Rows are reused in place, so
  // an unowned pass must clear both.
  _applyOwner(node, owner) {
    node.classList.toggle('owned', !!owner);
    if (owner) node.style.setProperty('--owner-color', conductorColor(owner));
    else node.style.removeProperty('--owner-color');
  }

  _ownerLabel(sid) {
    return ownerLabel(sid, { conductors: this._conductors, instances: this.instances });
  }

  // Create-or-update one session row (an <li> wrapping the .session-row div).
  // Built once with create-only click/delete/promote handlers that read a
  // mutable `holder` so they always see the freshest session (its instanceId
  // changes across crash+resume); every re-render patches the volatile bits
  // (status dot, active/live/unread classes, ago label, badges) in place. The
  // conditional badges/buttons are themselves keyed-reconciled so they slot in
  // at the right position without disturbing the always-present children.
  //   showOwner — draw the conductor bar for a live conducted session (the
  //               Projects lens, where no worktree row carries it instead).
  //   readOnly  — no promote / archive buttons (the Conductors tree).
  //   showStage — the playbook · stage line under the label (Conductors tree).
  _sessionRow(existing, { session, projectName, worktreeName, showOwner = false, readOnly = false, showStage = false }) {
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

    const owner = showOwner ? session.ownerSessionId ?? null : null;
    if (owner) tooltipParts.push(`conductor: ${this._ownerLabel(owner)}`);

    row.className = 'session-row' + (isActive ? ' active' : '') + (isLive ? ' live' : '') + (unread > 0 ? ' has-unread' : '') + (session.instanceTemp ? ' temp' : '') + (session.conducted ? ' conducted' : '') + (session.archived ? ' archived' : '') + (customTitle ? ' has-title' : '');
    this._applyOwner(row, owner);
    row.title = tooltipParts.join('\n');

    const resumeLabel = session.autoResumeAt ? formatAutoResumeTime(session.autoResumeAt) : null;
    const showPromote = !readOnly && session.instanceTemp && session.instanceId;
    const stage = showStage ? stageText(session) : null;
    const keys = ['dot', 'ago', showStage ? 'labelcol' : 'preview'];
    if (unread > 0) keys.push('unread');
    if (resumeLabel) keys.push('resume');
    if (showPromote) keys.push('promote');
    if (!readOnly) keys.push('delete');
    reconcileChildren(row, keys, (k, ex) => {
      if (k === 'dot') {
        return this._applyDot(ex ?? el('span', { class: 'dot' }), {
          status, awaitingWake: session.instanceAwaitingWake,
        });
      }
      if (k === 'labelcol') {
        // The preview plus, only for a bound worker, its verbatim
        // playbook · stage on a second line.
        const col = ex ?? el('span', { class: 'session-label-col' });
        reconcileChildren(col, stage ? ['preview', 'stage'] : ['preview'], (ck, cex) => {
          const node = cex ?? el('span', { class: ck === 'preview' ? 'session-preview' : 'session-stage' });
          node.textContent = ck === 'preview' ? liveLabel : stage;
          return node;
        });
        return col;
      }
      if (k === 'ago') {
        const ago = ex ?? el('span', { class: 'session-ago' });
        ago.textContent = formatAgo(session.lastActivity);
        if (session.lastActivity) ago.dataset.activity = String(session.lastActivity);
        else delete ago.dataset.activity;
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
  _sessionsNode(existing, { project, worktreeName, liveInstances, summary, showOwner = false }) {
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
      det._live = { liveInstances, summary, showOwner };
      det._loading = false;

      const setStatus = (text) => reconcileChildren(listEl, ['status'], (k, ex) => {
        const li = ex ?? el('li', { class: 'sessions-empty' });
        li.textContent = text;
        return li;
      });

      det._renderList = (onDisk) => {
        // The conductor filter narrows the rows, never the summary counts:
        // a selected conductor keeps only its own sessions, Hand-spawned only
        // drops every conducted one.
        const filterOwner = this._filterOwner();
        const merged = mergeLive(onDisk, det._live.liveInstances).filter(s =>
          filterOwner ? s.ownerSessionId === filterOwner
            : this.filter === 'hand' ? !s.conducted
              : true);
        if (merged.length === 0) {
          reconcileChildren(listEl, ['empty'], (k, ex) => ex ?? el('li', { class: 'sessions-empty' }, 'no sessions'));
          return;
        }
        // Two pinned sections below the normal list, each under a dim
        // divider, so the user can see them at a glance without losing the
        // lastActivity sort over the normal sessions above:
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
          return this._sessionRow(ex, {
            session: byKey.get(k), projectName: project.name, worktreeName, showOwner: det._live.showOwner,
          });
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

      det._update = ({ liveInstances, summary, showOwner }) => {
        det._live = { liveInstances, summary, showOwner };
        const total = this._sessionsTotal({ project, worktreeName, liveInstances, summary });
        const liveSummary = liveInstances.length > 0 ? ` · ${liveInstances.length} live` : '';
        det._summaryText.nodeValue = `Sessions (${total})${liveSummary}`;
        if (summary?.lastActivity) {
          if (!det._lastAgoSpan) {
            det._lastAgoSpan = el('span', { class: 'sessions-last-ago' });
            det._summaryEl.appendChild(det._lastAgoSpan);
          }
          det._lastAgoSpan.textContent = ` · last ${formatAgo(summary.lastActivity)}`;
          det._lastAgoSpan.dataset.activity = String(summary.lastActivity);
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

    det._update({ liveInstances, summary, showOwner });
    return det;
  }

  // Create-or-update the head row of a worktree item (buttons + name + base +
  // the merge-status pill). Buttons capture stable strings, so they're built
  // create-only; the pill is inserted/removed at its fixed position (between
  // name and base) on update. `readOnly` (the Conductors tree, fixed for the
  // node's life) builds it without the spawn and remove buttons.
  _worktreeHead(existing, { project: p, wt, readOnly = false }) {
    let head = existing;
    if (!head) {
      head = el('div', { class: 'worktree-row' });
      head.appendChild(el('button', {
        class: 'commit-log', title: 'commit history',
        onclick: (e) => { e.stopPropagation(); this.onShowCommits?.(p.name, wt.worktreeName); },
      }, '≡'));
      const nameSpan = el('span', { class: 'worktree-name' });
      head.appendChild(nameSpan);
      const baseSpan = el('span', { class: 'worktree-base' });
      head.appendChild(baseSpan);
      head.appendChild(el('button', {
        class: 'wt-review', title: 'review changes',
        onclick: (e) => { e.stopPropagation(); this.onReviewWorktree?.(p.name, wt.worktreeName); },
      }, '±'));
      if (!readOnly) {
        head.appendChild(el('button', {
          class: 'wt-spawn', title: 'new session in this worktree',
          onclick: (e) => { e.stopPropagation(); this.onCreateInstanceClick(p.name, { worktreeName: wt.worktreeName }); },
        }, '+'));
        head.appendChild(el('button', {
          class: 'wt-remove', title: 'remove worktree',
          onclick: (e) => { e.stopPropagation(); this.onRemoveWorktree(p.name, wt.worktreeName); },
        }, '×'));
      }
      head._nameSpan = nameSpan;
      head._baseSpan = baseSpan;
      head._pill = el('span', { class: 'wt-unmerged' });
    }
    const { _nameSpan: nameSpan, _baseSpan: baseSpan, _pill: pill } = head;
    nameSpan.textContent = wt.worktreeName;
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
  // Ownership colour comes from every live instance in the worktree: one
  // conductor → the head carries its bar and the rows none; several → the
  // head stays plain and each conducted row carries its own.
  _worktreeNode(existing, { project: p, wt, liveInstances }) {
    const li = existing ?? el('li', { class: 'worktree-item' });
    const showSessions = this._sessionsTotal({ project: p, worktreeName: wt.worktreeName, liveInstances, summary: wt.sessions }) > 0;
    const own = worktreeOwnership(this._owners.get(`${p.name}:${wt.worktreeName}`));
    const keys = ['head'];
    if (showSessions) keys.push('sessions');
    reconcileChildren(li, keys, (ck, ex) => {
      if (ck === 'head') {
        const head = this._worktreeHead(ex, { project: p, wt });
        const owner = own.kind === 'single' ? own.owner : null;
        this._applyOwner(head, owner);
        if (owner) head.title = `conductor: ${this._ownerLabel(owner)}`;
        else head.removeAttribute('title');
        return head;
      }
      return this._sessionsNode(ex, {
        project: p, worktreeName: wt.worktreeName, liveInstances, summary: wt.sessions,
        showOwner: own.kind !== 'single',
      });
    });
    return li;
  }

  // Create-or-update the Worktrees subnode (stable <details>) — count in the
  // summary is patched, and the worktree items are keyed-reconciled by name.
  // While a conductor filter is selected the group is forced open once per
  // selection, and that forced state is never recorded as the user's own
  // expansion; clearing the filter restores the recorded state. Hand-spawned
  // only narrows the list the same way but forces nothing open.
  _worktreeGroup(existing, { project: p, worktrees, byWorktree }) {
    const filterOwner = this._filterOwner();
    let det = existing;
    if (!det) {
      det = el('details', { class: 'worktree-group' });
      if (this.expandedWorktrees.has(p.name)) det.setAttribute('open', '');
      det._forcedFor = null;
      det.addEventListener('toggle', () => {
        if (this._filterOwner()) return;
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
    if (filterOwner && det._forcedFor !== filterOwner) {
      det.open = true;
      det._forcedFor = filterOwner;
    } else if (!filterOwner && det._forcedFor) {
      det.open = this.expandedWorktrees.has(p.name);
      det._forcedFor = null;
    }
    det._summaryEl.textContent = `Worktrees (${worktrees.length})`;
    const listed = filterOwner
      ? worktrees.filter(wt => this._owners.get(`${p.name}:${wt.worktreeName}`)?.has(filterOwner))
      : this.filter === 'hand'
        ? worktrees.filter(wt => this._hasHandSession({ liveInstances: byWorktree.get(`${p.name}:${wt.worktreeName}`) ?? [], summary: wt.sessions }))
        : worktrees;
    const wtByName = new Map(listed.map(wt => [wt.worktreeName, wt]));
    const keys = listed.map(wt => `wt:${wt.worktreeName}`);
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
  // `readOnly` (the Conductors tree, fixed for the row's life) builds it without
  // the new-session and delete buttons and never makes the system pill a
  // control.
  _projectRow(existing, { project: p, readOnly = false }) {
    let row = existing;
    if (!row) {
      row = el('div', { class: 'project-row' });
      row._readOnly = readOnly;
      const holder = { p };
      // Commit-log button goes first (left of the name) for git projects.
      // Non-git projects and an UNMEASURABLE one (its system could not be
      // reached, so `isGitRepo` is absent rather than false) get an
      // inert spacer of the same footprint so the name column stays aligned
      // across all row kinds. Both are built once and swapped per render — the
      // fact they depend on is live.
      row._logBtn = el('button', {
        class: 'commit-log', title: 'commit history',
        onclick: (e) => { e.stopPropagation(); this.onShowCommits?.(holder.p.name); },
      }, '≡');
      // Spacer glyph + box model must stay in sync with .commit-log button or alignment breaks.
      row._logSpacer = el('span', { class: 'commit-log-spacer', 'aria-hidden': 'true' }, '≡');
      row.appendChild(row._logSpacer);
      const nameSpan = el('span', { class: 'project-name' }, p.name);
      row.appendChild(nameSpan);
      if (!readOnly) {
        // Attached per render: a session starts on the machine cc runs on, so
        // this is not offered for a project whose tree is on another system —
        // a button that can only refuse is worse than no button.
        row._addBtn = el('button', {
          class: 'add-instance', title: 'new session',
          onclick: () => this.onCreateInstanceClick(holder.p.name),
        }, '+');
        row.appendChild(el('button', {
          class: 'delete-project', title: 'delete project',
          onclick: (e) => { e.stopPropagation(); this.onDeleteProject(holder.p); },
        }, '×'));
      }
      // Says which machine the project's tree is on, and — when cc could not
      // reach it — that this is why the row carries no git facts. Without it the
      // row degrades to something indistinguishable from a plain non-git
      // project, which is a wrong answer wearing the shape of an answer.
      // Clickable when — and only when — the target can actually be changed:
      // the change verifies the new target on the system before persisting, so
      // on an unreachable one it could only refuse, and the pill stays a REASON
      // rather than becoming a control that fails. `role`/`tabindex` are set per
      // render for the same reason, alongside the class.
      row._systemPill = el('span', {
        class: 'system-pill',
        onclick: (e) => {
          e.stopPropagation();
          if (row._systemPill.getAttribute('role') !== 'button') return;
          this.onEditProjectRemote?.(holder.p);
        },
        onkeydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          if (row._systemPill.getAttribute('role') !== 'button') return;
          e.preventDefault();
          e.stopPropagation();
          this.onEditProjectRemote?.(holder.p);
        },
      });
      row._nameSpan = nameSpan;
      row._pill = el('span', { class: 'wt-unmerged' });
      // Its own element, not a second mode of _pill: the two are independent
      // facts, and both are (re)positioned on every render so a first commit
      // clears this one without the row being rebuilt.
      row._noCommitsPill = el('span', {
        class: 'no-commits-pill',
        title: 'no commits yet — make a first commit to enable worktrees',
      }, 'no commits');
      row._holder = holder;
    }
    row._holder.p = p;
    const { _nameSpan: nameSpan, _pill: pill, _noCommitsPill: noCommits, _systemPill: systemPill } = row;
    // Absence of `system` is the local answer, exactly as the record reads it.
    const remote = !!p.system && p.system !== 'local';
    const unreachable = p.systemUnreachable || null;
    // The log needs measured git facts; an unreachable system has none, and
    // `isGitRepo` is deliberately ABSENT there rather than false.
    const showLog = p.isGitRepo === true;
    const wantLog = showLog ? row._logBtn : row._logSpacer;
    if (row.firstChild !== wantLog) row.replaceChild(wantLog, row.firstChild);
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
    if (p.unbornHead) {
      // Anchored after the ahead/behind pill when that one is showing, so the
      // two keep a stable order; the merge-pill block above owns its own slot.
      if (!noCommits.isConnected) (pill.isConnected ? pill : nameSpan).after(noCommits);
    } else if (noCommits.isConnected) {
      noCommits.remove();
    }
    if (remote || unreachable) {
      // One system can serve many targets, so the pill names WHICH — a pill
      // saying only the system would leave the row silent about which machine
      // its facts came from.
      const where = p.remoteId
        ? `remote '${p.remoteId}' of system '${p.system}'`
        : `system '${p.system}'`;
      systemPill.textContent = p.remoteId ? `${p.system}/${p.remoteId}` : (p.system || 'unknown system');
      systemPill.title = unreachable
        ? unreachable
        : `this project's tree, git repo and commands live on ${where} at ${p.path}`
          + ` — a worker session runs the claude CLI here and redirects its shell and file tools there.`
          + ` Click to change which target it is on.`;
      systemPill.classList.toggle('system-pill-unreachable', !!unreachable);
      const clickable = remote && !unreachable && !!this.onEditProjectRemote && !row._readOnly;
      if (clickable) {
        systemPill.setAttribute('role', 'button');
        systemPill.setAttribute('tabindex', '0');
      } else {
        systemPill.removeAttribute('role');
        systemPill.removeAttribute('tabindex');
      }
      if (!systemPill.isConnected) {
        (noCommits.isConnected ? noCommits : pill.isConnected ? pill : nameSpan).after(systemPill);
      }
    } else if (systemPill.isConnected) {
      systemPill.remove();
    }
    // A worker session on a REMOTE project is real: the CLI runs here, but
    // inside a chroot onto the system's own filesystem, so its files and its
    // shell both land there. On
    // an UNREACHABLE one it cannot start at all, so the button stays hidden
    // rather than offered and then failing. Delete stays on both: unregistering
    // is what a user can still do, and it never touches the tree.
    const addBtn = row._addBtn;
    if (addBtn) {
      const showAdd = !unreachable;
      if (showAdd && !addBtn.isConnected) row.querySelector('.delete-project').before(addBtn);
      else if (!showAdd && addBtn.isConnected) addBtn.remove();
    }
    return row;
  }

  // Create-or-update a project's list item (project row + optional Sessions
  // subnode + optional Worktrees subnode). Shared between top-level unassigned
  // items and workspace-nested items. The <li>'s own children are
  // keyed-reconciled so a Sessions subnode can appear/vanish (between the row
  // and the Worktrees group) without a teardown. Under a selected conductor the
  // Sessions subnode and the worktrees are listed only where it owns something;
  // under Hand-spawned only, only where a hand-spawned session is.
  _projectItem(existing, { project: p, directByProject, byWorktree }) {
    const li = existing ?? el('li', {});
    const allDirects = directByProject.get(p.name) ?? [];
    const worktrees = Array.isArray(p.worktrees) ? p.worktrees : [];
    const filterOwner = this._filterOwner();
    let showSessions = this._sessionsTotal({ project: p, worktreeName: null, liveInstances: allDirects, summary: p.sessions }) > 0;
    let showWorktrees = worktrees.length > 0;
    if (filterOwner) {
      showSessions = allDirects.some(i => i.ownerSessionId === filterOwner);
      showWorktrees = worktrees.some(wt => this._owners.get(`${p.name}:${wt.worktreeName}`)?.has(filterOwner));
    } else if (this.filter === 'hand') {
      showSessions = this._hasHandSession({ liveInstances: allDirects, summary: p.sessions });
      showWorktrees = worktrees.some(wt => this._hasHandSession({ liveInstances: byWorktree.get(`${p.name}:${wt.worktreeName}`) ?? [], summary: wt.sessions }));
    }

    const keys = ['row'];
    if (showSessions) keys.push('sessions');
    // Project with neither sessions nor worktrees — show a tiny hint so the
    // "+" button is discoverable.
    else if (worktrees.length === 0 && !filterOwner) keys.push('hint');
    if (showWorktrees) keys.push('worktrees');

    reconcileChildren(li, keys, (ckey, ex) => {
      if (ckey === 'row') return this._projectRow(ex, { project: p });
      if (ckey === 'sessions') return this._sessionsNode(ex, { project: p, worktreeName: null, liveInstances: allDirects, summary: p.sessions, showOwner: true });
      if (ckey === 'hint') return ex ?? el('div', { class: 'empty-project-hint' }, 'no sessions yet — tap + to start');
      return this._worktreeGroup(ex, { project: p, worktrees, byWorktree });
    });
    return li;
  }

  // Create-or-update a workspace container (<li> → stable <details>). Toggle
  // listener + edit button are create-only; the member project items are
  // keyed-reconciled by name (with an `empty` placeholder when the workspace
  // has no members). `count` is the workspace's full membership, which a
  // conductor filter narrowing `members` leaves unchanged.
  _workspaceItem(existing, { name, members, count, directByProject, byWorktree }) {
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
    li._countSpan.textContent = `(${count})`;
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

  // The owner sessionId the Projects lens is filtered to, or null for All /
  // Hand-spawned only.
  _filterOwner() {
    return this.filter && this.filter !== 'hand' ? this.filter : null;
  }

  render() {
    // A selected conductor that owns no live instance any more falls back to
    // All: an empty tree would be a filter nothing can clear by itself.
    const liveOwners = new Set(this.instances.map(i => i.ownerSessionId).filter(Boolean));
    if (this._filterOwner() && !liveOwners.has(this.filter)) this.filter = '';
    this._owners = ownersByPlace(this.instances);
    this._conductors = deriveConductors({ conductRows: this.conductRows, instances: this.instances });

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

    this._renderFilter(liveOwners);
    this._renderProjects({ directByProject, byWorktree });
    if (this.conductorList) this._renderConductors();
    if (this.stripRoot) this._renderStrip();
  }

  // The needs-you strip: Waiting on you, Running, Finished — each only when
  // non-empty, and no strip at all when every group is empty. The same strip
  // in both lenses; the conductor filter does not narrow it.
  _renderStrip() {
    const g = deriveStrip({ conductors: this._conductors.live, instances: this.instances });
    reconcileChildren(this.stripRoot, isStripEmpty(g) ? [] : ['strip'], (k, ex) => {
      const strip = ex ?? el('div', { class: 'sidebar-strip' });
      const names = Object.keys(STRIP_HEADS).filter(name => g[name].length > 0);
      reconcileChildren(strip, names.map(name => `group:${name}`), (gk, gex) => {
        const name = gk.slice(6);
        const entries = g[name];
        let group = gex;
        if (!group) {
          group = el('div', { class: `strip-group ${name}` });
          group._head = el('div', { class: 'strip-head' });
          group._ul = el('ul', { class: 'strip-list' });
          group.appendChild(group._head);
          group.appendChild(group._ul);
        }
        group._head.textContent = `${STRIP_HEADS[name]} (${entries.length})`;
        const bySid = new Map(entries.map(e => [e.sessionId, e]));
        reconcileChildren(group._ul, entries.map(e => `entry:${e.sessionId}`),
          (ek, eex) => this._stripEntry(eex, bySid.get(ek.slice(6)), name));
        return group;
      });
      return strip;
    });
  }

  // One strip entry: the dot and the label. Its state is not rendered as text
  // (the dot and the heading carry it); it is in the tooltip and the accessible
  // name.
  _stripEntry(existing, entry, group) {
    let li = existing, holder, btn;
    if (!li) {
      li = el('li', {});
      holder = { entry };
      btn = el('button', {
        type: 'button', class: 'strip-entry',
        onclick: () => this.onSelectInstance(holder.entry.instanceId),
      });
      li.appendChild(btn);
      li._holder = holder;
      li._btn = btn;
    } else {
      holder = li._holder;
      btn = li._btn;
    }
    holder.entry = entry;
    const reason = entryReason(entry, group);
    btn.className = 'strip-entry' + (entry.instanceId === this.activeInstanceId ? ' active' : '');
    this._applyOwner(btn, entry.conductor ? entry.sessionId : null);
    btn.title = `${entry.label}\n${reason}`;
    btn.setAttribute('aria-label', `${entry.label} — ${reason}`);
    reconcileChildren(btn, ['dot', 'title'], (k, ex) => {
      if (k === 'dot') {
        return this._applyDot(ex ?? el('span', { class: 'dot' }), {
          status: entry.status, awaitingWake: entry.awaitingWake,
          awaitingUser: entry.awaitingUser, awaitingUserSource: entry.awaitingUserSource,
        });
      }
      const t = ex ?? el('span', { class: 'strip-title' });
      t.textContent = entry.label;
      return t;
    });
    return li;
  }

  // Reconcile the conductor filter's options: All, Hand-spawned only, then one
  // per live owner — live conductors, inactive conductors, then owners that are not
  // conductors (a hand-spawned session that spawned workers).
  _renderFilter(liveOwners) {
    const select = this._filterSelect;
    if (!select) return;
    const order = [];
    for (const c of [...this._conductors.live, ...this._conductors.inactive]) {
      if (liveOwners.has(c.sessionId)) order.push(c.sessionId);
    }
    for (const sid of liveOwners) if (!order.includes(sid)) order.push(sid);
    const opts = [['', 'All sessions'], ['hand', 'Hand-spawned only'],
      ...order.map(sid => [sid, this._ownerLabel(sid)])];
    const labelOf = new Map(opts);
    reconcileChildren(select, opts.map(([v]) => `opt:${v}`), (k, ex) => {
      const value = k.slice(4);
      const o = ex ?? el('option', { value });
      o.textContent = labelOf.get(value);
      return o;
    });
    select.value = this.filter;
    this._applyOwner(this.filterRoot, this._filterOwner());
  }

  _renderProjects({ directByProject, byWorktree }) {
    if (this.projects.length === 0) {
      reconcileChildren(this.list, ['empty'], (key, existing) => existing ?? el('li', { class: 'project-row' },
        el('span', { class: 'project-name' }, 'no projects yet')));
      return;
    }

    // Under a selected conductor only the projects holding one of its live
    // sessions are listed; under Hand-spawned only, only those whose main
    // checkout or a worktree holds a hand-spawned session. Either way a
    // workspace is listed only with a visible member.
    const filterOwner = this._filterOwner();
    const ownedProjects = new Set(this.instances.filter(i => filterOwner && i.ownerSessionId === filterOwner).map(i => i.project));
    const hasHand = (p) => this._hasHandSession({ liveInstances: directByProject.get(p.name) ?? [], summary: p.sessions })
      || (Array.isArray(p.worktrees) ? p.worktrees : []).some(wt => this._hasHandSession({
        liveInstances: byWorktree.get(`${p.name}:${wt.worktreeName}`) ?? [], summary: wt.sessions,
      }));
    const visible = (p) => (filterOwner ? ownedProjects.has(p.name) : this.filter === 'hand' ? hasHand(p) : true);

    // Split into workspace-assigned (rendered first, nested under <details>)
    // and unassigned (rendered flat underneath, as their own section — see the
    // `.project-workspace-item + li` rule in styles.css). Workspace order is
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

    const workspaceNames = [...byWorkspace.keys()].sort((a, b) => a.localeCompare(b))
      .filter(name => !this.filter || byWorkspace.get(name).some(visible));
    const shownUnassigned = unassigned.filter(visible);
    const unassignedByName = new Map(shownUnassigned.map(p => [p.name, p]));

    const keys = [];
    for (const name of workspaceNames) keys.push(`ws:${name}`);
    for (const p of shownUnassigned) keys.push(`proj:${p.name}`);

    reconcileChildren(this.list, keys, (key, existing) => {
      if (key.startsWith('ws:')) {
        const name = key.slice(3);
        const all = byWorkspace.get(name);
        return this._workspaceItem(existing, {
          name, members: all.filter(visible), count: all.length, directByProject, byWorktree,
        });
      }
      const name = key.slice(5); // proj:
      return this._projectItem(existing, { project: unassignedByName.get(name), directByProject, byWorktree });
    });
  }

  // The Conductors lens: live conductors newest first, then a collapsed
  // *Inactive (n)* group of the rest, or an empty state when there are none.
  _renderConductors() {
    const { live, inactive } = this._conductors;
    const keys = live.map(c => `${CONDUCTOR_KEY}${c.sessionId}`);
    if (inactive.length > 0) keys.push('inactive');
    if (keys.length === 0) keys.push('empty');
    const liveBySid = new Map(live.map(c => [c.sessionId, c]));
    reconcileChildren(this.conductorList, keys, (k, ex) => {
      if (k === 'empty') return ex ?? el('li', { class: 'conductor-empty' }, 'no conductors yet — tap 🎼 Conduct');
      if (k === 'inactive') return this._inactiveGroup(ex, inactive);
      return this._conductorItem(ex, liveBySid.get(k.slice(CONDUCTOR_KEY.length)));
    });
  }

  _inactiveGroup(existing, inactive) {
    let li = existing;
    if (!li) {
      li = el('li', { class: 'conductor-inactive-item' });
      const det = el('details', { class: 'worktree-group conductor-inactive' });
      if (this.inactiveOpen) det.setAttribute('open', '');
      det.addEventListener('toggle', () => { this.inactiveOpen = det.open; });
      const summaryEl = el('summary', { class: 'worktree-summary' });
      const ul = el('ul', { class: 'conductor-inactive-list' });
      det.appendChild(summaryEl);
      det.appendChild(ul);
      li.appendChild(det);
      li._summaryEl = summaryEl;
      li._ul = ul;
    }
    li._summaryEl.textContent = `Inactive (${inactive.length})`;
    const bySid = new Map(inactive.map(c => [c.sessionId, c]));
    reconcileChildren(li._ul, inactive.map(c => `${CONDUCTOR_KEY}${c.sessionId}`),
      (k, ex) => this._conductorItem(ex, bySid.get(k.slice(CONDUCTOR_KEY.length))));
    return li;
  }

  // Create-or-update one conductor block: its row, its project chips, and —
  // while expanded — the read-only tree of this conductor's live workers.
  // The block alone carries the conductor's bar; nothing inside repeats it.
  _conductorItem(existing, conductor) {
    let li = existing, holder;
    if (!li) {
      li = el('li', { class: 'conductor-block' });
      holder = { conductor };
      li._holder = holder;
    } else {
      holder = li._holder;
    }
    holder.conductor = conductor;
    const sid = conductor.sessionId;
    const open = this.expandedConductors.has(sid);
    li.className = 'conductor-block' + (conductor.live ? '' : ' inactive') + (open ? ' open' : '');
    li.style.setProperty('--owner-color', conductorColor(sid));
    const workers = workersOf(sid, this.instances);
    const projects = conductorProjects(workers);

    const keys = ['row', 'chips'];
    if (open) keys.push('tree');
    reconcileChildren(li, keys, (k, ex) => {
      if (k === 'row') return this._conductorRow(ex, holder, open);
      if (k === 'chips') {
        const chips = ex ?? el('div', { class: 'conductor-chips' });
        const ck = projects.length > 0 ? projects.map(p => `chip:${p}`) : ['none'];
        reconcileChildren(chips, ck, (c, cex) => {
          if (c === 'none') return cex ?? el('span', { class: 'conductor-chip conductor-chip-none' }, 'no live workers');
          const chip = cex ?? el('span', { class: 'conductor-chip' });
          chip.textContent = c.slice(5);
          return chip;
        });
        return chips;
      }
      return this._conductorTree(ex, workers, projects);
    });
    return li;
  }

  _conductorRow(existing, holder, open) {
    let row = existing;
    if (!row) {
      row = el('div', {
        class: 'conductor-row',
        onclick: () => {
          const c = holder.conductor;
          if (c.instanceId) this.onSelectInstance(c.instanceId);
          else if (this.onResumeSession) this.onResumeSession({ projectName: '.conduct', worktreeName: null, sessionId: c.sessionId });
        },
      });
      row._caret = el('button', {
        type: 'button', class: 'conductor-caret', 'aria-label': 'show workers',
        onclick: (e) => {
          e.stopPropagation();
          const sid = holder.conductor.sessionId;
          if (this.expandedConductors.has(sid)) this.expandedConductors.delete(sid);
          else this.expandedConductors.add(sid);
          this.render();
        },
      }, '▸');
    }
    const c = holder.conductor;
    const { text, untitled } = conductorTitle(c);
    const unread = this.unreadBySessionId.get(c.sessionId) ?? 0;
    row.className = 'conductor-row' + (c.instanceId && c.instanceId === this.activeInstanceId ? ' active' : '');
    row.title = c.sessionId;
    row._caret.setAttribute('aria-expanded', open ? 'true' : 'false');
    const keys = ['caret', 'dot', 'title', 'ago'];
    if (unread > 0) keys.push('unread');
    keys.push('delete');
    reconcileChildren(row, keys, (k, ex) => {
      if (k === 'caret') return row._caret;
      if (k === 'dot') {
        return this._applyDot(ex ?? el('span', { class: 'dot' }), {
          status: c.instanceDisplayStatus ?? c.instanceStatus ?? 'offline',
          awaitingWake: c.instanceAwaitingWake,
          awaitingUser: c.awaitingUser, awaitingUserSource: c.awaitingUserSource,
        });
      }
      if (k === 'title') {
        const t = ex ?? el('span', {});
        t.className = 'conductor-title' + (untitled ? ' untitled' : '');
        t.textContent = text;
        return t;
      }
      if (k === 'ago') {
        const ago = ex ?? el('span', { class: 'session-ago' });
        ago.textContent = formatAgo(c.lastActivity);
        if (c.lastActivity) ago.dataset.activity = String(c.lastActivity);
        else delete ago.dataset.activity;
        return ago;
      }
      if (k === 'unread') {
        const b = ex ?? el('span', { class: 'session-unread' });
        b.textContent = String(unread);
        b.title = `${unread} new turn${unread === 1 ? '' : 's'} since you last viewed this session`;
        return b;
      }
      // delete — the session row's archive ×. A conductor with no transcript
      // listed yet goes through the synthetic (kill-only) path.
      return ex ?? el('button', {
        class: 'session-delete', title: 'archive session (keeps history)',
        onclick: (e) => {
          e.stopPropagation();
          const c = holder.conductor;
          if (this.onDeleteSession) this.onDeleteSession({
            projectName: '.conduct', worktreeName: null, sessionId: c.sessionId,
            preview: conductorTitle(c).text, synthetic: !c.onDisk,
          });
        },
      }, '×');
    });
    return row;
  }

  // Expanded conductor: per project (sorted), the project row, then the workers
  // in its main checkout, then each worktree (sorted by name) holding one with
  // its workers. Only this conductor's live workers, all read-only.
  _conductorTree(existing, workers, projects) {
    const ul = existing ?? el('ul', { class: 'conductor-tree' });
    const projByName = new Map(this.projects.map(p => [p.name, p]));
    reconcileChildren(ul, projects.map(n => `proj:${n}`), (k, ex) => {
      const name = k.slice(5);
      const p = projByName.get(name) ?? { name, worktrees: [] };
      const mine = workers.filter(w => w.project === name);
      const direct = mine.filter(w => !w.worktree?.worktreeName);
      const byWt = new Map();
      for (const w of mine) {
        const wtName = w.worktree?.worktreeName;
        if (!wtName) continue;
        if (!byWt.has(wtName)) byWt.set(wtName, []);
        byWt.get(wtName).push(w);
      }
      const wtNames = [...byWt.keys()].sort((a, b) => a.localeCompare(b));
      const li = ex ?? el('li', {});
      const keys = ['row'];
      if (direct.length > 0) keys.push('direct');
      if (wtNames.length > 0) keys.push('wts');
      reconcileChildren(li, keys, (ck, cex) => {
        if (ck === 'row') return this._projectRow(cex, { project: p, readOnly: true });
        if (ck === 'direct') return this._workerList(cex ?? el('ul', { class: 'sessions-list conductor-direct' }), direct, name, null);
        const wtUl = cex ?? el('ul', { class: 'worktree-list' });
        reconcileChildren(wtUl, wtNames.map(n => `wt:${n}`), (wk, wex) => {
          const wtName = wk.slice(3);
          const ws = byWt.get(wtName);
          const wt = (Array.isArray(p.worktrees) ? p.worktrees : []).find(x => x.worktreeName === wtName)
            ?? { ...ws[0].worktree, worktreeName: wtName };
          const item = wex ?? el('li', { class: 'worktree-item' });
          reconcileChildren(item, ['head', 'sessions'], (ik, iex) => {
            if (ik === 'head') return this._worktreeHead(iex, { project: p, wt, readOnly: true });
            return this._workerList(iex ?? el('ul', { class: 'sessions-list' }), ws, name, wtName);
          });
          return item;
        });
        return wtUl;
      });
      return li;
    });
    return ul;
  }

  _workerList(ul, workers, projectName, worktreeName) {
    const rows = workers.filter(w => w.sessionId).map(sessionFromInstance)
      .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    const bySid = new Map(rows.map(r => [r.sessionId, r]));
    reconcileChildren(ul, rows.map(r => `sess:${r.sessionId}`), (k, ex) => this._sessionRow(ex, {
      session: bySid.get(k.slice(5)), projectName, worktreeName, readOnly: true, showStage: true,
    }));
    return ul;
  }
}
