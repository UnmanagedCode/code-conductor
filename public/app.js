// Frontend bootstrap. Loads projects + instances over REST, subscribes to
// instance updates over WebSocket, and wires the sidebar/composer to actions.

import { bus, connect, send } from './ws.js';
import { Sidebar } from './sidebar.js';
import { Conversation } from './conversation.js';
import { attachComposer } from './composer.js';
import { formatUserQuestionAnswers } from './blocks.js';
import { TaskTracker, TaskPanel } from './tasks.js';
import {
  UsageTracker, contextWindowFor,
  formatTokens, formatPct, formatDuration, fillClass,
} from './usage.js';
import {
  NotificationState, ensurePermission, setGlobalEnabled,
  maybeNotifyTurnEnd, isNotificationAPIAvailable,
} from './notifications.js';
import { readSessionAnchor, writeSessionAnchor } from './anchor.js';

const state = {
  projects: [],
  instances: [],
  activeId: null,
  activeStatus: null,
  activeMode: null,
};

const dom = {
  projectList: document.getElementById('project-list'),
  conversation: document.getElementById('conversation'),
  composerForm: document.getElementById('composer'),
  composerInput: document.getElementById('composer-input'),
  composerSend: document.getElementById('composer-send'),
  composerAttach: document.getElementById('composer-attach'),
  composerFile: document.getElementById('composer-file'),
  composerAttachments: document.getElementById('composer-attachments'),
  modeSelect: document.getElementById('mode-select'),
  killBtn: document.getElementById('kill-btn'),
  resumeBtn: document.getElementById('resume-btn'),
  instanceTitle: document.getElementById('instance-title'),
  taskPanel: document.getElementById('task-panel'),
  turnIndicator: document.getElementById('turn-indicator'),
  tiLeft: document.getElementById('ti-left'),
  tiUsageSlot: document.getElementById('ti-usage-slot'),
  newProjectBtn: document.getElementById('new-project-btn'),
  newProjectDialog: document.getElementById('new-project-dialog'),
  npName: document.getElementById('np-name'),
  npError: document.getElementById('np-error'),
  npPreview: document.getElementById('np-preview'),
  newInstanceDialog: document.getElementById('new-instance-dialog'),
  niProject: document.getElementById('ni-project'),
  niMode: document.getElementById('ni-mode'),
  niEffort: document.getElementById('ni-effort'),
  niThinking: document.getElementById('ni-thinking'),
  niModel: document.getElementById('ni-model'),
  niWorktree: document.getElementById('ni-worktree'),
  niWorktreeHint: document.getElementById('ni-worktree-hint'),
  niTemp: document.getElementById('ni-temp'),
  niDebug: document.getElementById('ni-debug'),
  niError: document.getElementById('ni-error'),
  syncBtn: document.getElementById('sync-btn'),
  mergeBtn: document.getElementById('merge-btn'),
  debugBtn: document.getElementById('debug-btn'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebar: document.getElementById('sidebar'),
  sidebarScrim: document.getElementById('sidebar-scrim'),
  notifyToggle: document.getElementById('notify-toggle'),
  restartBtn: document.getElementById('restart-server-btn'),
  sidebarStatus: document.getElementById('sidebar-status'),
};

// Per-instance task trackers — one TaskTracker is kept alive per
// observed instance so switching tabs and back doesn't lose the
// running list. The panel mounts the tracker for whichever instance
// is currently active.
const taskTrackersByInstance = new Map();
function getTracker(instanceId) {
  let t = taskTrackersByInstance.get(instanceId);
  if (!t) { t = new TaskTracker(); taskTrackersByInstance.set(instanceId, t); }
  return t;
}
const taskPanel = new TaskPanel(dom.taskPanel);

// Per-instance context-usage trackers. Same lifecycle as the task
// trackers: reset()+replay on snapshot, apply(ev) on each live event.
// The active instance's tracker drives the `ctx N%` header chip and the
// session-totals popover.
const usageTrackersByInstance = new Map();
function getUsage(instanceId) {
  let u = usageTrackersByInstance.get(instanceId);
  if (!u) { u = new UsageTracker(); usageTrackersByInstance.set(instanceId, u); }
  return u;
}

// Pending user-question answers waiting for the active instance to reach
// idle. If the user picks an option while a turn is still running, the
// answer prompt would race with the in-flight stream — claude's stdin can
// accept queued messages but the timing was producing dropped or misordered
// responses. We hold the answer here and flush it when status flips to idle.
const pendingAnswersByInstance = new Map();

function flushPendingAnswers(instanceId) {
  const queue = pendingAnswersByInstance.get(instanceId);
  if (!queue || queue.length === 0) return;
  for (const text of queue) send('prompt', { id: instanceId, text });
  pendingAnswersByInstance.delete(instanceId);
}

function sendOrQueuePrompt(instanceId, text) {
  const inst = state.instances.find(i => i.id === instanceId);
  if (inst && inst.status === 'idle') {
    send('prompt', { id: instanceId, text });
  } else {
    const queue = pendingAnswersByInstance.get(instanceId) ?? [];
    queue.push(text);
    pendingAnswersByInstance.set(instanceId, queue);
  }
}

const conversation = new Conversation(dom.conversation, {
  // Source thumbnails for attachment chips on transcript replay. The
  // live echo carries dataBase64; the replay path falls through to
  // this resolver, which builds an HTTP URL into the per-instance
  // attachments endpoint. Returns null when nothing is active.
  resolveAttachmentUrl: (filename) => {
    if (!state.activeId || !filename) return null;
    return `/api/instances/${encodeURIComponent(state.activeId)}/attachments/${encodeURIComponent(filename)}`;
  },
  // Lookups for TaskUpdate's summary line — see describeToolInput.
  // Always reads through whichever tracker the active instance owns,
  // so the tool block can resolve the task's subject + description by
  // its numeric id (the input only carries `taskId`).
  describeToolCtx: {
    resolveTaskSubject: (id) => {
      const t = state.activeId ? taskTrackersByInstance.get(state.activeId) : null;
      return t ? t.getSubject(id) : null;
    },
    resolveTaskDescription: (id) => {
      const t = state.activeId ? taskTrackersByInstance.get(state.activeId) : null;
      return t ? t.getDescription(id) : null;
    },
  },
  onUserQuestionSubmit: ({ questions, answers }) => {
    if (!state.activeId) return;
    // The CLI auto-errors AskUserQuestion in stream-json mode, so we
    // deliver the consolidated answers back as a single normal prompt on
    // the next turn. If a turn is still in flight, queue and flush on
    // status=idle.
    sendOrQueuePrompt(state.activeId, formatUserQuestionAnswers(questions, answers));
  },
  onPermissionDecision: ({ toolUseId, allow }) => {
    if (!state.activeId) return;
    // Forward the Allow/Deny click to the orchestrator over WS. The
    // server resolves the held-open PreToolUse hook HTTP response and
    // the CLI then either runs the tool or auto-denies it.
    send('hook_decision', { id: state.activeId, toolUseId, allow });
  },
  onPlanDecision: async ({ decision, feedback }) => {
    if (!state.activeId) return;
    const activeId = state.activeId;
    if (decision === 'approve') {
      // Switch the instance to bypassPermissions so the model can actually
      // implement what was just approved without every tool call hitting
      // the "Claude requested permission" auto-deny. Best-effort — if the
      // mode switch fails (e.g. instance just crashed), still send the
      // approval prompt and let the user adjust mode manually.
      try { await send('mode', { id: activeId, mode: 'bypassPermissions' }, { ack: true }); }
      catch (e) { console.warn('plan-approve mode switch failed', e); }
      const text = feedback
        ? `I approve the plan. Additional notes: ${feedback}\n\nPlease proceed with the implementation.`
        : 'I approve the plan. Please proceed with the implementation.';
      sendOrQueuePrompt(activeId, text);
    } else {
      const text = feedback
        ? `I'd like to revise the plan. Refinement notes:\n${feedback}`
        : `I'd like to revise the plan. Please refine it.`;
      sendOrQueuePrompt(activeId, text);
    }
  },
});

const sidebar = new Sidebar({
  rootList: dom.projectList,
  onSelectInstance: selectInstance,
  onCreateInstanceClick: openNewInstanceDialog,
  onRemoveWorktree: removeWorktree,
  onDeleteProject: deleteProject,
  onResumeSession: resumeSession,
  onLoadSessions: loadSessions,
  onDeleteSession: deleteSession,
});

const composer = attachComposer({
  form: dom.composerForm,
  textarea: dom.composerInput,
  sendBtn: dom.composerSend,
  attachBtn: dom.composerAttach,
  fileInput: dom.composerFile,
  chipsContainer: dom.composerAttachments,
  onSubmit: ({ text, attachments }) => {
    if (!state.activeId) return;
    const payload = { id: state.activeId, text };
    if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
    send('prompt', payload);
  },
});

dom.modeSelect.addEventListener('change', async () => {
  if (!state.activeId) return;
  const mode = dom.modeSelect.value;
  try { await send('mode', { id: state.activeId, mode }, { ack: true }); }
  catch (e) { alert(`mode change failed: ${e.message}`); }
});

dom.killBtn.addEventListener('click', () => {
  if (!state.activeId) return;
  if (state.activeStatus === 'turn') {
    send('interrupt', { id: state.activeId });
  } else if (confirm('Kill this instance?')) {
    send('kill', { id: state.activeId });
  }
});

dom.debugBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  dom.debugBtn.disabled = true;
  dom.debugBtn.textContent = '🐛 starting…';
  try {
    const r = await fetch(`/api/instances/${state.activeId}/debug`, { method: 'POST' });
    const result = await r.json();
    if (!r.ok || !result.ok) {
      throw new Error(result.error ?? result.reason ?? 'failed to enable debug');
    }
    // Reflect the new state locally so updateActiveHeader can flip the
    // button label immediately. A status event will follow anyway and
    // overwrite this with the authoritative summary.
    const inst = state.instances.find(i => i.id === state.activeId);
    if (inst) { inst.debug = true; inst.debugDir = result.debugDir; }
    updateActiveHeader();
    alert(`Debug capture started. Writing to:\n${result.debugDir}`);
  } catch (e) {
    alert('Failed to enable debug: ' + e.message);
    dom.debugBtn.disabled = false;
    dom.debugBtn.textContent = '🐛 Debug';
  }
});

dom.syncBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  try {
    const r = await fetch(`/api/instances/${state.activeId}/sync`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error);
    const result = await r.json();
    if (!result.ok) { alert(`Cannot sync:\n${result.reason}`); return; }
    if (result.action === 'already-in-sync') {
      alert('Worktree is already up to date with its parent branch.');
    } else if (result.action === 'fast-forwarded') {
      alert(`Synced worktree → ${result.newSha?.slice(0, 12) ?? '?'}`);
    } else if (result.action === 'rebase-prompt-sent') {
      alert('Rebase prompt sent to the agent — watch the conversation for REBASE_DONE, then click Merge.');
    }
    await refreshProjects();
  } catch (e) { alert(`sync failed: ${e.message}`); }
});
dom.mergeBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  if (!confirm('Fast-forward the parent branch onto this worktree\'s tip?')) return;
  try {
    const r = await fetch(`/api/instances/${state.activeId}/merge`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error);
    const result = await r.json();
    if (result.ok) {
      alert(`Merged into parent → ${result.newSha?.slice(0, 12) ?? '?'}`);
      await refreshProjects();
    } else {
      alert(`Cannot merge:\n${result.reason}`);
    }
  } catch (e) { alert(`merge failed: ${e.message}`); }
});

dom.resumeBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  try {
    const r = await fetch(`/api/instances/${state.activeId}/respawn`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error);
    await refreshInstances();
    if (state.activeId) send('subscribe', { id: state.activeId });
  } catch (e) { alert(`resume failed: ${e.message}`); }
});

dom.newProjectBtn.addEventListener('click', () => {
  dom.npName.value = '';
  dom.npError.textContent = '';
  dom.npPreview.textContent = '~/project/<name>';
  dom.newProjectDialog.showModal();
});
dom.npName.addEventListener('input', () => {
  dom.npPreview.textContent = `~/project/${dom.npName.value || '<name>'}`;
});
dom.newProjectDialog.addEventListener('close', async () => {
  if (dom.newProjectDialog.returnValue !== 'create') return;
  const name = dom.npName.value.trim();
  if (!name) return;
  try {
    const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!r.ok) throw new Error((await r.json()).error);
    await refreshProjects();
  } catch (e) {
    dom.npError.textContent = e.message;
    dom.newProjectDialog.showModal();
  }
});

function setSidebarOpen(open) {
  dom.sidebar.classList.toggle('open', open);
  dom.sidebarScrim.classList.toggle('open', open);
  dom.sidebarToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}
dom.sidebarToggle.addEventListener('click', () => {
  setSidebarOpen(!dom.sidebar.classList.contains('open'));
});

function renderNotifyToggle() {
  const on = NotificationState.globalEnabled && NotificationState.permission === 'granted';
  dom.notifyToggle.textContent = on ? '🔔' : '🔕';
  dom.notifyToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  dom.notifyToggle.title = !isNotificationAPIAvailable()
    ? 'Notifications unsupported in this browser'
    : NotificationState.permission === 'denied'
      ? 'Notifications blocked — change in browser site settings'
      : on
        ? 'Notifications on — tap to mute'
        : 'Notifications off — tap to enable';
}
dom.notifyToggle.addEventListener('click', async () => {
  if (!isNotificationAPIAvailable()) { renderNotifyToggle(); return; }
  if (NotificationState.globalEnabled) {
    setGlobalEnabled(false);
    renderNotifyToggle();
    return;
  }
  const perm = await ensurePermission();
  if (perm === 'granted') setGlobalEnabled(true);
  renderNotifyToggle();
});
NotificationState.permission = isNotificationAPIAvailable() ? Notification.permission : 'unsupported';
if (NotificationState.permission === 'granted') {
  // User previously granted permission. Auto-enable + register the SW so
  // notifications actually fire on mobile (which requires SW transport).
  setGlobalEnabled(true);
  ensurePermission().catch(() => {});
}
renderNotifyToggle();
dom.sidebarScrim.addEventListener('click', () => setSidebarOpen(false));

// Restart-server button. Self-respawn happens server-side: POST kicks
// the orchestrator which spawns a detached replacement and exits.
// Once the new server is responding to HTTP again we trigger a full
// `location.reload()` so frontend assets (HTML/CSS/JS) get re-fetched
// too — otherwise the open tab keeps its pre-restart code in memory.
let restartInProgress = false;
function setSidebarStatus(text, { warn = false } = {}) {
  if (!dom.sidebarStatus) return;
  dom.sidebarStatus.textContent = text;
  dom.sidebarStatus.classList.toggle('warn', !!warn && !!text);
}
async function waitForServerBack({ tries = 60, delayMs = 250 } = {}) {
  // Poll a cheap endpoint until it answers. cache:'no-store' is
  // important — without it the SW or HTTP cache could serve a stale
  // 200 from before the restart and we'd reload too early.
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('/api/projects', { cache: 'no-store' });
      if (r.ok) return true;
    } catch { /* server still down */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}
dom.restartBtn.addEventListener('click', async () => {
  if (restartInProgress) return;
  restartInProgress = true;
  dom.restartBtn.disabled = true;
  setSidebarStatus('restarting…', { warn: true });
  // Fire the restart. The server replies 202 then exits; the fetch
  // may either resolve or be aborted mid-flight — both are fine.
  await fetch('/api/admin/restart', { method: 'POST' }).catch(() => {});
  // Give the server a moment to actually exit + spawn the replacement
  // before we start probing, so the first probe doesn't hit the
  // still-alive old server and reload prematurely.
  await new Promise(r => setTimeout(r, 800));
  setSidebarStatus('waiting for server…', { warn: true });
  await waitForServerBack();
  setSidebarStatus('reloading…', { warn: true });
  // Full reload so the new HTML/CSS/JS replace what's in memory.
  location.reload();
});
// Background connection status (unrelated to manual restart): show
// "reconnecting…" if the WS drops on its own, clear it on reconnect.
let everConnected = false;
let everDropped = false;
bus.addEventListener('open', () => {
  everConnected = true;
  if (everDropped && !restartInProgress) {
    setSidebarStatus('');
    everDropped = false;
  }
});
bus.addEventListener('close', () => {
  if (!everConnected || restartInProgress) return;
  everDropped = true;
  setSidebarStatus('reconnecting…', { warn: true });
});
bus.addEventListener('reconnecting', () => {
  if (!everConnected || restartInProgress) return;
  setSidebarStatus('reconnecting…', { warn: true });
});

let pendingNewInstanceProject = null;
// Worktree intent for the new-instance dialog:
//   null              — normal spawn at the project root
//   true              — create a fresh worktree and spawn into it
//   '<worktreeName>'  — spawn into an existing worktree
let pendingWorktreeIntent = null;

async function openNewInstanceDialog(projectName, opts = {}) {
  pendingNewInstanceProject = projectName;
  pendingWorktreeIntent = opts.worktreeName ?? null;
  dom.niProject.textContent = projectName;
  dom.niMode.value = 'plan';
  dom.niEffort.value = 'high';
  dom.niThinking.value = 'adaptive';
  dom.niModel.value = '';
  dom.niError.textContent = '';

  // Worktree row: checkbox + status line. Greyed out if the project
  // isn't a git repo; pre-locked if the caller passed an existing
  // worktree name (e.g. from the Worktrees sidebar subnode).
  const proj = state.projects.find(p => p.name === projectName);
  const isGit = !!proj?.isGitRepo;
  if (pendingWorktreeIntent) {
    dom.niWorktree.checked = true;
    dom.niWorktree.disabled = true;
    dom.niWorktreeHint.textContent = `will spawn into existing worktree: ${pendingWorktreeIntent}`;
  } else {
    dom.niWorktree.checked = false;
    dom.niWorktree.disabled = !isGit;
    dom.niWorktreeHint.textContent = isGit
      ? 'creates a sibling worktree under ~/project/, branched off current HEAD'
      : 'project is not a git repo — `git init` first to use worktrees';
  }

  dom.niTemp.checked = false;
  dom.niDebug.checked = false;
  // Resume is no longer driven from this dialog — the sidebar's
  // "Sessions" subnode handles that with one-click resume. The dialog
  // only spawns FRESH sessions.
  dom.newInstanceDialog.showModal();
}

// Ticking "Temp session" nudges the mode dropdown to code, since a
// temp session is almost always for *doing*, not planning. The user
// can still override.
dom.niTemp.addEventListener('change', () => {
  if (dom.niTemp.checked) dom.niMode.value = 'bypassPermissions';
});
dom.newInstanceDialog.addEventListener('close', async () => {
  if (dom.newInstanceDialog.returnValue !== 'create') return;
  const project = pendingNewInstanceProject;
  const mode = dom.niMode.value;
  const effort = dom.niEffort.value;
  const thinking = dom.niThinking.value;
  const model = dom.niModel.value || undefined;
  const temp = dom.niTemp.checked || undefined;
  const debug = dom.niDebug.checked || undefined;
  // Worktree intent: pre-locked name (existing) > checkbox (fresh) > omitted.
  let worktree;
  if (typeof pendingWorktreeIntent === 'string') worktree = pendingWorktreeIntent;
  else if (dom.niWorktree.checked) worktree = true;
  try {
    const r = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, mode, effort, thinking, model, worktree, temp, debug }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const inst = await r.json();
    await refreshProjects();
    await refreshInstances();
    selectInstance(inst.id);
  } catch (e) {
    dom.niError.textContent = e.message;
    dom.newInstanceDialog.showModal();
  }
});

// Fetches sessions for a project (or for a specific worktree under it).
// Called by the sidebar when the user expands the "Sessions" subnode.
async function loadSessions(projectName, worktreeName) {
  const url = worktreeName
    ? `/api/projects/${encodeURIComponent(projectName)}/worktrees/${encodeURIComponent(worktreeName)}/sessions`
    : `/api/projects/${encodeURIComponent(projectName)}/sessions`;
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json()).error);
  return r.json();
}

// One-click resume from the sidebar. We POST with worktree carried
// through (so resuming a worktree session lands in the same worktree
// cwd) and use orchestrator defaults for mode/effort/thinking. The
// orchestrator's resume default is `code` (bypassPermissions) — fresh
// spawns default to plan, but a resume is almost always continuing
// real work. Switch via the header mode dropdown if needed.
async function resumeSession({ projectName, worktreeName, sessionId }) {
  try {
    const r = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: projectName,
        resume: sessionId,
        worktree: worktreeName || undefined,
      }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const inst = await r.json();
    await refreshProjects();
    await refreshInstances();
    selectInstance(inst.id);
  } catch (e) {
    alert(`resume failed: ${e.message}`);
  }
}

async function deleteProject(project) {
  const insts = state.instances.filter(i => i.project === project.name);
  const wts = project.worktrees ?? [];
  const summary = [
    `Delete project '${project.name}'?`,
    `Path: ${project.path}`,
    ``,
    `This will:`,
    `  • kill ${insts.length} running instance${insts.length === 1 ? '' : 's'}`,
    `  • remove ${wts.length} worktree${wts.length === 1 ? '' : 's'} (dir + branch)`,
    `  • rm -rf the project directory itself`,
    ``,
    `(Your ~/.claude/projects/ session history is left in place.)`,
    `Type the project name to confirm:`,
  ].join('\n');
  const typed = window.prompt(summary, '');
  if (typed !== project.name) {
    if (typed !== null) alert(`Name mismatch — nothing deleted.`);
    return;
  }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(project.name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error);
    if (state.activeId && insts.some(i => i.id === state.activeId)) {
      state.activeId = null;
    }
    await refreshProjects();
    await refreshInstances();
  } catch (e) {
    alert(`delete project failed: ${e.message}`);
  }
}

async function deleteSession({ projectName, worktreeName, sessionId, preview }) {
  const label = preview && preview !== '(new session)' && preview !== `${sessionId.slice(0, 8)}…`
    ? `"${preview}"`
    : sessionId.slice(0, 8) + '…';
  if (!confirm(`Delete session ${label}?\nThis removes the persisted transcript jsonl.`)) return;
  const base = worktreeName
    ? `/api/projects/${encodeURIComponent(projectName)}/worktrees/${encodeURIComponent(worktreeName)}/sessions/${encodeURIComponent(sessionId)}`
    : `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}`;
  try {
    let r = await fetch(base, { method: 'DELETE' });
    if (r.status === 409) {
      const { error } = await r.json();
      if (!confirm(`${error}\n\nKill the running instance and delete anyway?`)) return;
      r = await fetch(`${base}?force=1`, { method: 'DELETE' });
    }
    if (!r.ok) throw new Error((await r.json()).error);
    // If we were focused on this session's instance, drop the focus.
    const inst = state.instances.find(i => i.sessionId === sessionId);
    if (inst && state.activeId === inst.id) state.activeId = null;
    // Drop any cached sessions for the affected scope so the
    // subnode re-fetches on next render.
    if (sidebar.sessionsCache) {
      const key = worktreeName ? `${projectName}:${worktreeName}` : projectName;
      sidebar.sessionsCache.delete(key);
    }
    await refreshProjects();
    await refreshInstances();
  } catch (e) {
    alert(`delete session failed: ${e.message}`);
  }
}

async function removeWorktree(project, worktreeName) {
  if (!confirm(`Remove worktree '${worktreeName}'?\nThis will delete the directory and branch.`)) return;
  try {
    let r = await fetch(`/api/projects/${encodeURIComponent(project)}/worktrees/${encodeURIComponent(worktreeName)}`, { method: 'DELETE' });
    if (r.status === 409) {
      // Either a running instance or uncommitted changes — offer force.
      const { error } = await r.json();
      if (!confirm(`${error}\n\nForce remove anyway?`)) return;
      r = await fetch(`/api/projects/${encodeURIComponent(project)}/worktrees/${encodeURIComponent(worktreeName)}?force=1`, { method: 'DELETE' });
    }
    if (!r.ok) throw new Error((await r.json()).error);
    await refreshProjects();
    await refreshInstances();
  } catch (e) {
    alert(`remove worktree failed: ${e.message}`);
  }
}

async function refreshProjects() {
  state.projects = await (await fetch('/api/projects')).json();
  sidebar.setProjects(state.projects);
}
async function refreshInstances() {
  state.instances = await (await fetch('/api/instances')).json();
  sidebar.setInstances(state.instances);
  updateActiveHeader();
}

function selectInstance(id) {
  if (state.activeId && state.activeId !== id) send('unsubscribe', { id: state.activeId });
  state.activeId = id;
  sidebar.setActive(id);
  conversation.clear();
  updateActiveHeader();
  // Swap the task panel onto whichever instance just became active.
  taskPanel.attach(id ? getTracker(id) : null);
  send('subscribe', { id });
  // Anchor the active session in the URL so a page refresh restores it.
  // Uses sessionId (stable across crash/resume), not the transient instance id.
  const inst = id ? state.instances.find(i => i.id === id) : null;
  writeSessionAnchor(inst?.sessionId || null);
  if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false);
}

function updateActiveHeader() {
  // The header gets rebuilt from scratch on every call, which discards
  // the existing chip nodes. Close any open popover first so it's not
  // left hanging off a detached anchor.
  closeUsagePopover();
  const inst = state.instances.find(i => i.id === state.activeId);
  if (!inst) {
    dom.instanceTitle.textContent = 'no instance selected';
    dom.modeSelect.disabled = true;
    dom.killBtn.textContent = 'Interrupt';
    dom.killBtn.disabled = true;
    dom.resumeBtn.hidden = true;
    composer.disable();
    dom.composerInput.placeholder = 'select or spawn an instance to start chatting';
    dom.turnIndicator.hidden = true;
    dom.tiLeft.hidden = true;
    dom.tiUsageSlot.textContent = '';
    return;
  }
  state.activeStatus = inst.status;
  state.activeMode = inst.mode;
  // Build the title as discrete chips so it wraps cleanly on mobile —
  // a single text string was wrapping at the `·` separators and landing
  // them alone on lines.
  dom.instanceTitle.textContent = '';
  const chip = (cls, text) => {
    const e = document.createElement('span');
    e.className = `ih-chip ${cls}`;
    e.textContent = text;
    return e;
  };
  dom.instanceTitle.appendChild(chip('ih-project', inst.project));
  if (inst.worktree?.worktreeName) {
    const wtShort = inst.worktree.worktreeName.replace(`${inst.project}_worktree_`, 'wt:');
    dom.instanceTitle.appendChild(chip('ih-worktree',
      `${wtShort} (← ${inst.worktree.baseBranch})`));
  }
  dom.instanceTitle.appendChild(chip('ih-sid', inst.sessionId?.slice(0, 8) ?? '?'));
  dom.instanceTitle.appendChild(chip(`ih-status ih-status-${inst.status}`, inst.status));
  dom.instanceTitle.appendChild(chip('ih-mode', inst.mode === 'bypassPermissions' ? 'code' : inst.mode));
  if (inst.temp) dom.instanceTitle.appendChild(chip('ih-temp', 'temp'));
  if (inst.debug) dom.instanceTitle.appendChild(chip('ih-debug', 'debug'));
  // The ctx chip lives in the bottom bar's right slot rather than the header,
  // so a filled `ctx 6% · 62k/1.0M` readout doesn't push the right-side
  // controls onto a third row on mobile.
  dom.tiUsageSlot.textContent = '';
  dom.tiUsageSlot.appendChild(renderUsageChip(inst));
  dom.modeSelect.value = inst.mode;
  dom.modeSelect.disabled = inst.status === 'turn' || inst.status === 'crashed' || inst.status === 'exited';
  dom.killBtn.textContent = inst.status === 'turn' ? 'Interrupt' : 'Kill';
  dom.killBtn.disabled = !['idle', 'turn', 'spawning'].includes(inst.status);
  dom.resumeBtn.hidden = !(inst.status === 'crashed' || inst.status === 'exited');
  dom.turnIndicator.hidden = false;
  dom.tiLeft.hidden = inst.status !== 'turn';
  const hasWorktree = !!inst.worktree?.worktreeName;
  dom.syncBtn.hidden = !hasWorktree;
  dom.syncBtn.disabled = !hasWorktree;
  dom.mergeBtn.hidden = !hasWorktree;
  dom.mergeBtn.disabled = !hasWorktree;
  // Debug button: shown while the instance is alive and debug isn't on
  // yet. Once enabled it flips to a disabled '🐛 capturing' indicator —
  // there's no off path (the CLI stays mirrored for the rest of its life).
  const canDebug = ['idle', 'turn', 'spawning'].includes(inst.status);
  dom.debugBtn.hidden = !canDebug;
  if (inst.debug) {
    dom.debugBtn.textContent = '🐛 capturing';
    dom.debugBtn.disabled = true;
    dom.debugBtn.title = `mirroring to ${inst.debugDir ?? '(unknown path)'}`;
  } else {
    dom.debugBtn.textContent = '🐛 Debug';
    dom.debugBtn.disabled = false;
    dom.debugBtn.title = 'Start mirroring CLI stdin/stdout/stderr to .claude-orch-app/debug/<id>/';
  }
  const canType = ['idle', 'turn', 'spawning'].includes(inst.status);
  const canSend = ['idle', 'turn'].includes(inst.status);
  composer.set({ canType, canSend });
  dom.composerInput.placeholder = inst.status === 'turn'
    ? 'turn running — your message will queue'
    : inst.status === 'spawning'
      ? 'instance is starting…'
      : inst.status === 'crashed' || inst.status === 'exited'
        ? 'instance is not running — click Resume'
        : 'Send a message — Enter to send, Shift+Enter for newline';
}

// Build the `ctx N%` header chip for the given instance. Click toggles
// the session-totals popover. When no turn has landed yet the chip
// reads `ctx —` so it doesn't pop into existence after the first turn.
function renderUsageChip(inst) {
  const usage = getUsage(inst.id);
  const frac = usage.currentFillPct(inst.model);
  const used = usage.currentContextSize();
  const window = contextWindowFor(usage.effectiveModel(inst.model));
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `ih-chip ih-usage ${fillClass(frac)}`;
  el.setAttribute('aria-haspopup', 'dialog');
  el.setAttribute('aria-expanded', 'false');
  if (used == null) {
    el.textContent = 'ctx —';
    el.title = 'Context usage will appear after the first turn ends.';
  } else {
    el.textContent = `ctx ${formatPct(frac)} · ${formatTokens(used)}/${formatTokens(window)}`;
    el.title = `Last turn used ${used.toLocaleString()} of ${window.toLocaleString()} context tokens. Tap for session totals.`;
  }
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUsagePopover(el, inst);
  });
  return el;
}

let openUsagePopover = null;
function closeUsagePopover() {
  if (!openUsagePopover) return;
  const { node, anchor, dismiss } = openUsagePopover;
  node.remove();
  anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', dismiss, true);
  document.removeEventListener('keydown', dismiss, true);
  openUsagePopover = null;
}
function toggleUsagePopover(anchor, inst) {
  if (openUsagePopover && openUsagePopover.anchor === anchor) {
    closeUsagePopover();
    return;
  }
  closeUsagePopover();
  const node = buildUsagePopover(inst);
  document.body.appendChild(node);
  // Position above the chip (popover lives in the bottom footer bar, so
  // popping down would run off the viewport). Right-align so the panel
  // doesn't run off mobile screens.
  const r = anchor.getBoundingClientRect();
  node.style.top = `${Math.round(r.top - node.offsetHeight - 6)}px`;
  // Clamp left edge so the popover stays on-screen — anchor on the chip's
  // right edge so the panel grows to the left instead of clipping off-screen.
  const desiredLeft = r.right - node.offsetWidth;
  const maxLeft = window.innerWidth - node.offsetWidth - 8;
  node.style.left = `${Math.max(8, Math.min(desiredLeft, maxLeft))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const dismiss = (ev) => {
    if (ev.type === 'keydown') {
      if (ev.key === 'Escape') closeUsagePopover();
      return;
    }
    if (node.contains(ev.target) || anchor.contains(ev.target)) return;
    closeUsagePopover();
  };
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
  openUsagePopover = { node, anchor, dismiss };
}
function buildUsagePopover(inst) {
  const usage = getUsage(inst.id);
  const c = usage.cum;
  const window = contextWindowFor(usage.effectiveModel(inst.model));
  const modelLabel = usage.effectiveModel(inst.model) ?? '(default)';
  const totalCacheIn = c.cacheRead + c.cacheCreation;
  const totalIn = c.inputTokens + totalCacheIn;
  const cacheHit = totalIn > 0 ? c.cacheRead / totalIn : 0;
  const node = document.createElement('div');
  node.className = 'ih-usage-popover';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', 'Session usage totals');
  const row = (label, value) => {
    const r = document.createElement('div');
    r.className = 'ih-usage-row';
    const k = document.createElement('span'); k.className = 'ih-usage-k'; k.textContent = label;
    const v = document.createElement('span'); v.className = 'ih-usage-v'; v.textContent = value;
    r.appendChild(k); r.appendChild(v);
    return r;
  };
  const header = document.createElement('div');
  header.className = 'ih-usage-popover-header';
  header.textContent = 'Session totals';
  node.appendChild(header);
  const meta = document.createElement('div');
  meta.className = 'ih-usage-meta';
  meta.textContent = `${modelLabel} · ${formatTokens(window)} context`;
  node.appendChild(meta);
  if (c.turns === 0) {
    const empty = document.createElement('div');
    empty.className = 'ih-usage-empty-msg';
    empty.textContent = 'No turns have completed yet.';
    node.appendChild(empty);
    return node;
  }
  node.appendChild(row('Turns', String(c.turns)));
  node.appendChild(row('Duration', formatDuration(c.durationMs)));
  node.appendChild(row('Cost', `$${c.cost.toFixed(4)}`));
  node.appendChild(row('Input (uncached)', formatTokens(c.inputTokens)));
  node.appendChild(row('Output', formatTokens(c.outputTokens)));
  node.appendChild(row('Cache reads', `${formatTokens(c.cacheRead)} (${formatPct(cacheHit)} hit)`));
  node.appendChild(row('Cache creation', formatTokens(c.cacheCreation)));
  return node;
}

bus.addEventListener('snapshot', (e) => {
  const m = e.detail;
  // Rebuild task tracker from the snapshot for any instance we observe
  // — not just the active one — so the panel is correct the moment
  // the user flips to it. Same shape for the usage tracker so the
  // header chip lands populated when resuming a long historical session.
  const tracker = getTracker(m.id);
  tracker.reset();
  const usage = getUsage(m.id);
  usage.reset();
  for (const ev of m.events ?? []) {
    tracker.apply(ev);
    usage.apply(ev);
  }
  if (m.id !== state.activeId) return;
  conversation.clear();
  conversation.applyEvents(m.events ?? []);
  updateActiveHeader();
});

bus.addEventListener('event', (e) => {
  const m = e.detail;
  getTracker(m.id).apply(m.ev);
  getUsage(m.id).apply(m.ev);
  if (m.id !== state.activeId) return;
  conversation.apply(m.ev);
  // Refresh the header chip whenever data that affects it lands. init
  // sets the model, message_start gives a live mid-turn context-size
  // update (each agent-loop step fires its own with cumulative counts),
  // turn_end finalizes both current + cumulative totals.
  if (m.ev?.kind === 'turn_end'
      || m.ev?.kind === 'message_start'
      || (m.ev?.kind === 'system' && m.ev?.subtype === 'init')) {
    updateActiveHeader();
  }
});

bus.addEventListener('turn_notification', (e) => {
  const m = e.detail;
  maybeNotifyTurnEnd({
    instanceId: m.id,
    projectName: m.project ?? 'instance',
    turnEvent: { isError: m.isError, stopReason: m.stopReason, cost: m.cost },
  });
});

bus.addEventListener('status', (e) => {
  const m = e.detail;
  const inst = state.instances.find(i => i.id === m.id);
  if (inst) {
    inst.status = m.status;
    inst.mode = m.mode;
    inst.sessionId = m.sessionId;
    sidebar.setInstances(state.instances);
    if (m.id === state.activeId) updateActiveHeader();
  }
  // Now that this instance is idle again, drain any queued user-question
  // answers that came in while a turn was running.
  if (m.status === 'idle') flushPendingAnswers(m.id);
});

bus.addEventListener('instances', () => { refreshInstances(); });
bus.addEventListener('projects', () => { refreshProjects(); });

let firstConnect = true;
bus.addEventListener('open', async () => {
  await refreshProjects();
  await refreshInstances();
  // On the first WS open after page load, try to restore the session named
  // in the URL hash so a refresh keeps the user on the same conversation.
  // Guarded by firstConnect so a mid-session reconnect doesn't snap focus
  // back if the user has since navigated elsewhere or closed the instance.
  if (firstConnect) {
    firstConnect = false;
    if (!state.activeId) {
      const anchor = readSessionAnchor();
      if (anchor) {
        const inst = state.instances.find(i => i.sessionId === anchor);
        if (inst) {
          selectInstance(inst.id);
          return;
        }
      }
    }
  }
  if (state.activeId && state.instances.some(i => i.id === state.activeId)) {
    send('subscribe', { id: state.activeId });
  }
});

connect();
