// Frontend bootstrap. Loads projects + instances over REST, subscribes to
// instance updates over WebSocket, and wires the sidebar/composer to actions.

import { bus, connect, send } from './ws.js';
import { Sidebar } from './sidebar.js';
import { Conversation } from './conversation.js';
import { attachComposer } from './composer.js';
import { formatUserQuestionAnswers, autoSpeakBlock } from './blocks.js';
import { TaskTracker, TaskPanel } from './tasks.js';
import { SubagentPanel } from './subagents.js';
import { UsageTracker, RateLimitTracker } from './usage.js';
import {
  NotificationState, ensurePermission, setGlobalEnabled,
  isNotificationAPIAvailable, registerServiceWorker,
  closeAllOnFocus,
} from './notifications.js';
import {
  writeSessionAnchor, pushSessionAnchor, stashCurrentAnchorForRelaunch,
} from './anchor.js';
import { installExternalLinkOpener } from './external-links.js';
import { makeDismissable } from './dismissable.js';
import { installLazyHistoryController } from './lazyHistory.js';
import { installLightbox } from './lightbox.js';
import { installSettings } from './settings.js';
import { installReview } from './review.js';
import { installCommits } from './commits.js';
import { installCosts } from './costs.js';
import { installRestart } from './restartFlow.js';
import { installNewProjectDialog } from './newProjectDialog.js';
import { installWorkspaceDialog } from './workspaceDialog.js';
import { installSpawnDialog } from './spawnDialog.js';
import { installSessionActions } from './sessionActions.js';
import { installHeader } from './header.js';
import { installSessionSummary } from './sessionSummary.js';
import { installWsRouter } from './wsRouter.js';
import { loadModelVersions, setActiveVersions, setActiveSonnetWindow,
  setActiveFamilyEnabled, setActiveDefaultSpawnFamily } from './models.js';
import { setTtsAvailable, setTtsEnabled, setTtsRate } from './tts.js';

const state = {
  projects: [],
  instances: [],
  activeId: null,
  activeStatus: null,
  activeMode: null,
};

// Account-level usage fetched from /api/usage (OAuth endpoint, 60 s server cache).
// null until the first successful fetch; stays null on errors (chip degrades silently).
let accountUsage = null;

async function refreshAccountUsage() {
  try {
    const r = await fetch('/api/usage', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    accountUsage = j.usage ?? null;
    // Merge the tightest bucket from the fetch into globalRLTracker so the
    // combined chip shows real data even before a rate_limit_event arrives.
    // fetch = richer base; messages are sparse patches on top. Both use the
    // same apply() null-guard so neither clobbers the other's unique fields
    // (isUsingOverage is message-only and survives re-fetches because it is
    // intentionally absent from this synthetic event).
    if (accountUsage) {
      const BUCKET_PRIORITY = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus'];
      const key = BUCKET_PRIORITY.find(k => accountUsage[k]);
      if (key) {
        const b = accountUsage[key];
        globalRLTracker.apply({
          kind: 'system', subtype: 'rate_limit_event',
          data: { rate_limit_info: {
            rateLimitType: key,
            utilization: typeof b.utilization === 'number' ? b.utilization / 100 : undefined,
            resetsAt: b.resets_at ? new Date(b.resets_at).getTime() / 1000 : undefined,
          }},
        });
      }
    }
    if (state.activeId) headerHandle.update();
  } catch { /* ignore — chip degrades silently */ }
}

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
  subagentPanel: document.getElementById('subagent-panel'),
  turnIndicator: document.getElementById('turn-indicator'),
  tiLeft: document.getElementById('ti-left'),
  tiLabel: document.getElementById('ti-label'),
  tiInterruptNow: document.getElementById('ti-interrupt-now'),
  tiUsageSlot: document.getElementById('ti-usage-slot'),
  newProjectBtn: document.getElementById('new-project-btn'),
  newProjectDialog: document.getElementById('new-project-dialog'),
  npName: document.getElementById('np-name'),
  npError: document.getElementById('np-error'),
  npPreview: document.getElementById('np-preview'),
  npGuidelines: document.getElementById('np-guidelines'),
  npGuidelinesList: document.getElementById('np-guidelines-list'),
  newWorkspaceBtn: document.getElementById('new-workspace-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  workspaceDialog: document.getElementById('workspace-dialog'),
  gdTitle: document.getElementById('gd-title'),
  gdName: document.getElementById('gd-name'),
  gdProjectList: document.getElementById('gd-project-list'),
  gdEmptyHint: document.getElementById('gd-empty-hint'),
  gdError: document.getElementById('gd-error'),
  gdDelete: document.getElementById('gd-delete'),
  gdSave: document.getElementById('gd-save'),
  spawnDialog: document.getElementById('spawn-dialog'),
  sdProject: document.getElementById('sd-project'),
  sdModeCode: document.getElementById('sd-mode-code'),
  sdModePlan: document.getElementById('sd-mode-plan'),
  sdEffort: document.getElementById('sd-effort'),
  sdThinking: document.getElementById('sd-thinking'),
  sdWorktree: document.getElementById('sd-worktree'),
  sdWorktreeHint: document.getElementById('sd-worktree-hint'),
  sdTemp: document.getElementById('sd-temp'),
  sdDebug: document.getElementById('sd-debug'),
  sdError: document.getElementById('sd-error'),
  sdHookResult: document.getElementById('sd-hook-result'),
  sdHookSummary: document.getElementById('sd-hook-summary'),
  sdHookOutput: document.getElementById('sd-hook-output'),
  sdSpawn: document.getElementById('sd-spawn'),
  sdAdvanced: document.getElementById('sd-advanced'),
  conductBtn: document.getElementById('conduct-btn'),
  conductDialog: document.getElementById('conduct-dialog'),
  cdModeCode: document.getElementById('cd-mode-code'),
  cdModePlan: document.getElementById('cd-mode-plan'),
  cdError: document.getElementById('cd-error'),
  syncBtn: document.getElementById('sync-btn'),
  mergeBtn: document.getElementById('merge-btn'),
  debugBtn: document.getElementById('debug-btn'),
  summarizeSessionBtn: document.getElementById('summarize-session-btn'),
  summaryDialog: document.getElementById('summary-dialog'),
  renameSessionBtn: document.getElementById('rename-session-btn'),
  autoApprovePlanBtn: document.getElementById('auto-approve-plan-btn'),
  overflowMenu: document.getElementById('overflow-menu'),
  overflowToggle: document.getElementById('overflow-toggle'),
  overflowPanel: document.getElementById('overflow-panel'),
  sidebarOverflowMenu: document.getElementById('sidebar-overflow-menu'),
  sidebarOverflowToggle: document.getElementById('sidebar-overflow-toggle'),
  sidebarOverflowPanel: document.getElementById('sidebar-overflow-panel'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebar: document.getElementById('sidebar'),
  sidebarScrim: document.getElementById('sidebar-scrim'),
  notifyToggle: document.getElementById('notify-toggle'),
  restartBtn: document.getElementById('restart-server-btn'),
  sidebarStatus: document.getElementById('sidebar-status'),
  restartDialog: document.getElementById('restart-dialog'),
  restartBlurb: document.getElementById('rd-blurb'),
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

// Sub-agent panel: shows workers spawned by the active conductor instance.
// Populated from state.instances; updates arrive via instances hint.
const subagentPanel = new SubagentPanel(dom.subagentPanel);
subagentPanel.onNavigate = (instanceId) => selectInstance(instanceId, { push: true });

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

// Single global rate-limit tracker. Rate limits are account-wide (not
// per-session), so one tracker accumulates events from every instance and
// the periodic /api/usage fetch result. Both sources merge through
// RateLimitTracker.apply() with null-guard semantics: incoming non-null
// fields win; absent/undefined fields never clobber existing values.
const globalRLTracker = new RateLimitTracker();

// Pending user-question answers waiting for the active instance to reach
// idle. If the user picks an option while a turn is still running, the
// answer prompt would race with the in-flight stream — claude's stdin can
// accept queued messages but the timing was producing dropped or misordered
// responses. We hold the answer here and flush it when status flips to idle.
const pendingAnswersByInstance = new Map();

// Auto-approve-plan toggle now lives on the server (per Instance) and
// the flag is mirrored down through `snapshot` / `status` frames into
// each entry of `state.instances`. The client just renders the synced
// state and sends a WS message on toggle; the server is the one that
// actually approves the plan when an ExitPlanMode lands. This makes the
// toggle work even when the tab isn't focused on the affected session
// or is backgrounded entirely.

// Per-sessionId unread count. Incremented when a turn_notification lands
// for a session the user isn't currently viewing; cleared on
// selectInstance. Keyed by sessionId (not instance id) so the count
// survives a crash + resume cycle that mints a new instance id for the
// same session. Persisted to localStorage so it also survives page
// refreshes — turn_notifications keep firing for live background
// instances even when no tab is connected (the server-side ring buffer
// can't replay missed ones, but new ones after reload are counted).
const UNREAD_STORAGE_KEY = 'code-conductor:unread';
function loadUnreadFromStorage() {
  try {
    const raw = localStorage.getItem(UNREAD_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return new Map();
    return new Map(Object.entries(obj).filter(([, v]) => Number.isInteger(v) && v > 0));
  } catch {
    return new Map();
  }
}
function saveUnreadToStorage() {
  try {
    if (unreadBySessionId.size === 0) localStorage.removeItem(UNREAD_STORAGE_KEY);
    else localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(Object.fromEntries(unreadBySessionId)));
  } catch {
    // localStorage can throw (private mode, quota) — unread is best-effort.
  }
}
const unreadBySessionId = loadUnreadFromStorage();
function bumpUnread(sessionId) {
  if (!sessionId) return;
  unreadBySessionId.set(sessionId, (unreadBySessionId.get(sessionId) ?? 0) + 1);
  saveUnreadToStorage();
  sidebar.setUnread(unreadBySessionId);
}
function clearUnread(sessionId) {
  if (!sessionId) return;
  if (!unreadBySessionId.delete(sessionId)) return;
  saveUnreadToStorage();
  sidebar.setUnread(unreadBySessionId);
}

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

// Handles returned by installSessionActions ({ promoteSession, loadSessions,
// resumeSession, rewindActiveSession, forkActiveSession, deleteProject,
// deleteSession, removeWorktree, consumePendingPrefill }). Declared here —
// before conversationOptions and the Sidebar, both of which forward to it via
// lazy arrows — and assigned later, once its deps (sidebar et al.) are in scope.
// Every call site fires only after init (user interaction / async WS open).
let sessionActions = null;

// Handle returned by installHeader ({ update }, the renamed updateActiveHeader).
// Declared here — before selectInstance/refreshInstances and the WS-router
// handlers, all of which call headerHandle.update() — and assigned at the
// installHeader() call below, once its deps (composer, conversation) are in
// scope. Every update() call site fires only after init (user interaction,
// async REST, or a WS frame arriving after connect()), so the holder is always
// assigned first.
let headerHandle = null;

// Shared by the main conversation AND the detached batch renderers used
// for lazy-loaded older history (see loadEarlier below) — batches reuse the
// exact same block-rendering path, minus TTS auto-speak.
const conversationOptions = {
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
  onRewind: (userMessageIndex) => sessionActions.rewindActiveSession(userMessageIndex),
  onFork: (userMessageIndex) => sessionActions.forkActiveSession(userMessageIndex),
  // Read finalized assistant messages aloud when TTS auto-speak is enabled.
  onAssistantText: (block) => autoSpeakBlock(block),
};

const conversation = new Conversation(dom.conversation, conversationOptions);

// --- Lazy-load of older history (scroll-to-top) ---------------------------
// The controller (lazyHistory.js) owns the epoch/loading/sentinel state and
// the scroll-up paging of evicted events; app.js wires reset()/init() to the
// snapshot / reset_snapshot / selectInstance call sites below.
const lazyController = installLazyHistoryController({
  conversationEl: dom.conversation,
  conversation,
  conversationOptions,
  getActiveId: () => state.activeId,
  getInstances: () => state.instances,
});

// Handles returned by installWorkspaceDialog ({ openNew, openEdit }). Declared
// before the Sidebar so onEditWorkspace can forward to it; assigned later, once
// the dialog's deps (refreshProjects et al.) are in scope. Only reachable via
// user interaction, which can't fire until after full init runs the install.
let workspaceHandles = null;
// Handles returned by installSpawnDialog ({ openSpawnDialog, syncSonnetPickerLabels,
// syncFamilyVisibility }). Declared before the Sidebar/Settings installs so their
// callbacks can forward to it; assigned later, once the dialog's deps
// (refreshProjects et al.) are in scope. All three external callers fire only
// after init (user click / settings change / async loadModelVersions().then).
let spawnHandles = null;

const sidebar = new Sidebar({
  rootList: dom.projectList,
  onSelectInstance: selectInstance,
  onCreateInstanceClick: (projectName, opts) => spawnHandles.openSpawnDialog(projectName, opts),
  onRemoveWorktree: (...a) => sessionActions.removeWorktree(...a),
  onDeleteProject: (...a) => sessionActions.deleteProject(...a),
  onResumeSession: (...a) => sessionActions.resumeSession(...a),
  onLoadSessions: (...a) => sessionActions.loadSessions(...a),
  onDeleteSession: (...a) => sessionActions.deleteSession(...a),
  onEditWorkspace: (name) => workspaceHandles.openEdit(name),
  onPromoteSession: (...a) => sessionActions.promoteSession(...a),
});
// Seed the sidebar with any unread counts restored from localStorage so
// the pills appear on the first render after a page reload — without
// this, sidebar starts with an empty Map and the badges only reappear
// after the next bumpUnread fires.
sidebar.setUnread(unreadBySessionId);

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
  onResize: () => conversation._maybeScroll(),
});

// Active-instance header / chips / combined-usage popover (see public/header.js).
// Wired here once composer + conversation exist; closeOverflow is a hoisted
// function declaration (defined further down) so the reference is valid now.
// getAccountUsage is a getter because `accountUsage` is reassigned by the
// periodic /api/usage fetch. setActiveStatus/setActiveMode mirror onto the same
// live `state` object the killBtn handler reads.
headerHandle = installHeader({
  dom,
  getActiveId: () => state.activeId,
  getInstances: () => state.instances,
  setActiveStatus: (v) => { state.activeStatus = v; },
  setActiveMode: (v) => { state.activeMode = v; },
  getUsage,
  globalRLTracker,
  getAccountUsage: () => accountUsage,
  composer,
  conversation,
  closeOverflow,
});

// Enable the Send button's hold-to-record mic affordance only when the
// server has whisper.cpp + the model on disk. The Settings page can flip
// availability at runtime (install / model switch), so this is also called
// via onAvailabilityChange below.
function setMicAvailable(available) {
  composer.setMicAvailable(available);
}
(async () => {
  try {
    const r = await fetch('/api/transcribe/status', { cache: 'no-store' });
    if (!r.ok) return;
    const { available } = await r.json();
    setMicAvailable(available);
  } catch { /* leave mic disabled */ }
})();

// Probe Piper TTS availability (gates the 🔊 speak buttons) and seed the
// auto-speak/rate prefs. Mirrors the transcribe-status probe above.
(async () => {
  try {
    const r = await fetch('/api/tts/status', { cache: 'no-store' });
    if (r.ok) setTtsAvailable((await r.json()).available);
  } catch { /* leave TTS disabled */ }
  try {
    const r = await fetch('/api/settings/tts', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      setTtsEnabled(d.enabled);
      setTtsRate(d.rate);
    }
  } catch { /* prefs default off */ }
})();

// Settings page (full-page view at #settings). The burger-menu button routes
// here; closing restores the previously-active session anchor.
function closeSettings() {
  const inst = state.instances.find(i => i.id === state.activeId);
  writeSessionAnchor(inst?.sessionId || null);
}
const settings = installSettings({
  requestClose: closeSettings,
  onAvailabilityChange: setMicAvailable,
  onModelsChange: data => {
    setActiveVersions(data.active);
    setActiveSonnetWindow(data.sonnetContextWindow);
    if (data.enabledFamilies) setActiveFamilyEnabled(data.enabledFamilies);
    setActiveDefaultSpawnFamily(data.defaultSpawnFamily);
    spawnHandles.syncSonnetPickerLabels();
    spawnHandles.syncFamilyVisibility();
  },
  onTtsAvailabilityChange: setTtsAvailable,
  onTtsPrefsChange: ({ enabled, rate }) => { setTtsEnabled(enabled); setTtsRate(rate); },
  onOpenCostDashboard: () => { settings.close(); costs.open(); },
  // The Archived page restores/deletes sessions; drop the sidebar's
  // per-scope session caches so a restored session reappears (and a
  // deleted one disappears) on the next render.
  onArchivedChanged: () => {
    sidebar.sessionsCache?.clear?.();
    refreshProjects();
    refreshInstances();
  },
});
// Seed the per-family model-version cache the spawn pickers resolve against.
loadModelVersions().then(() => { spawnHandles.syncSonnetPickerLabels(); spawnHandles.syncFamilyVisibility(); });
dom.settingsBtn?.addEventListener('click', () => {
  closeSidebarOverflow();
  if (location.hash === '#settings') settings.close();
  else {
    setSidebarOpen(false);
    settings.open();
  }
});

// Review view (full-page diff browser opened from the sidebar ± button).
function closeReview() {
  const inst = state.instances.find(i => i.id === state.activeId);
  writeSessionAnchor(inst?.sessionId || null);
}
const review = installReview();
sidebar.onReviewWorktree = (project, wt) => {
  setSidebarOpen(false);
  const short = wt.replace(`${project}_worktree_`, '');
  review.open({
    title: `${project} / ${short}`,
    url: `/api/projects/${encodeURIComponent(project)}/worktrees/${encodeURIComponent(wt)}/diff`,
    onBack: closeReview,
  });
};

// Commit history view (full-page list opened from the sidebar ≡ button).
// Tapping a commit opens the shared diff renderer on top; backing out of the
// diff returns to the list via location.hash = '#commits'.
const commits = installCommits({ onClose: () => {
  const inst = state.instances.find(i => i.id === state.activeId);
  writeSessionAnchor(inst?.sessionId || null);
} });
sidebar.onShowCommits = (project) => {
  setSidebarOpen(false);
  commits.open(project);
};
commits.onOpenCommit = (project, c) => {
  const url = c.diffUrl
    ?? `/api/projects/${encodeURIComponent(project)}/commits/${encodeURIComponent(c.sha)}/diff`;
  review.open({
    title: c.sha ? `${c.shortSha} ${c.subject}` : c.subject,
    url,
  });
};

// Cost dashboard (opened from Settings → Models → "Cost dashboard" button).
const costs = installCosts({ onClose: () => {
  const inst = state.instances.find(i => i.id === state.activeId);
  writeSessionAnchor(inst?.sessionId || null);
} });

dom.modeSelect.addEventListener('change', async () => {
  if (!state.activeId) return;
  const mode = dom.modeSelect.value;
  try { await send('mode', { id: state.activeId, mode }, { ack: true }); }
  catch (e) { alert(`mode change failed: ${e.message}`); }
});

dom.killBtn.addEventListener('click', () => {
  if (!state.activeId) return;
  closeOverflow();
  if (state.activeStatus === 'turn') {
    // Default interrupt is SOFT — a hidden steer asking the model to wind
    // down. Escalate to a hard abort via the "Interrupt now" button.
    send('interrupt', { id: state.activeId });
  } else if (confirm('Terminate this instance?')) {
    send('kill', { id: state.activeId });
  }
});

// Turn-indicator escalate button: force-stop the in-flight turn (hard
// control_request abort) once a soft interrupt is underway.
dom.tiInterruptNow.addEventListener('click', () => {
  if (!state.activeId) return;
  send('interrupt', { id: state.activeId, force: true });
});

dom.autoApprovePlanBtn.addEventListener('click', () => {
  if (!state.activeId) return;
  const inst = state.instances.find(i => i.id === state.activeId);
  const next = !(inst && inst.autoApprovePlan);
  // Optimistic: flip the local mirror immediately so the button's
  // pressed-state updates without waiting for the status round-trip.
  // The next `status` frame will reassert the authoritative value.
  if (inst) inst.autoApprovePlan = next;
  headerHandle.update();
  send('auto_approve_plan', { id: state.activeId, enabled: next });
});

dom.renameSessionBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  const inst = state.instances.find(i => i.id === state.activeId);
  if (!inst?.sessionId) return;
  closeOverflow();
  const cur = inst.title ?? '';
  const next = prompt('Session title (empty to clear):', cur);
  if (next === null) return; // cancelled
  const trimmed = next.trim().slice(0, 100);
  if (trimmed === (cur ?? '').trim()) return; // no change
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(inst.sessionId)}/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    const result = await r.json();
    // Optimistic local mirror — the broadcast `status` frame will reassert.
    inst.title = result.title ?? null;
    headerHandle.update();
    await refreshProjects();
  } catch (e) {
    alert('Rename failed: ' + e.message);
  }
});

dom.summarizeSessionBtn.addEventListener('click', () => {
  closeOverflow();
  summaryHandle.open();
});

dom.debugBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  closeOverflow();
  dom.debugBtn.disabled = true;
  dom.debugBtn.textContent = '🐛 starting…';
  try {
    const r = await fetch(`/api/instances/${state.activeId}/debug`, { method: 'POST' });
    const result = await r.json();
    if (!r.ok || !result.ok) {
      throw new Error(result.error ?? result.reason ?? 'failed to enable debug');
    }
    // Reflect the new state locally so headerHandle.update() can flip the
    // button label immediately. A status event will follow anyway and
    // overwrite this with the authoritative summary.
    const inst = state.instances.find(i => i.id === state.activeId);
    if (inst) { inst.debug = true; inst.debugDir = result.debugDir; }
    headerHandle.update();
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
    } else if (result.action === 'rebased') {
      alert(`Worktree auto-rebased onto ${result.newSha?.slice(0, 12) ?? '?'} — click Merge when ready.`);
    } else if (result.action === 'rebase-prompt-sent') {
      alert('Rebase prompt sent to the agent — watch the conversation for REBASE_DONE, then click Merge.');
    }
    await refreshProjects();
  } catch (e) { alert(`sync failed: ${e.message}`); }
});
dom.mergeBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  if (!confirm('Merge this worktree\'s branch into the parent? A merge commit will be created on the parent.')) return;
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

installNewProjectDialog({
  dom: {
    newProjectBtn: dom.newProjectBtn,
    newProjectDialog: dom.newProjectDialog,
    npName: dom.npName,
    npError: dom.npError,
    npPreview: dom.npPreview,
    npGuidelines: dom.npGuidelines,
    npGuidelinesList: dom.npGuidelinesList,
  },
  refreshProjects,
  closeSidebarOverflow,
});

// Workspace dialog (new + edit): see public/workspaceDialog.js. We own the
// newWorkspaceBtn click (close the sidebar overflow, then openNew) and forward
// the sidebar's onEditWorkspace to openEdit via the workspaceHandles holder.
workspaceHandles = installWorkspaceDialog({
  dom: {
    workspaceDialog: dom.workspaceDialog,
    gdTitle: dom.gdTitle,
    gdName: dom.gdName,
    gdProjectList: dom.gdProjectList,
    gdEmptyHint: dom.gdEmptyHint,
    gdError: dom.gdError,
    gdDelete: dom.gdDelete,
    gdSave: dom.gdSave,
  },
  getProjects: () => state.projects,
  refreshProjects,
});

dom.newWorkspaceBtn.addEventListener('click', () => {
  closeSidebarOverflow();
  workspaceHandles.openNew();
});

// Spawn + Conduct dialogs and the model-picker sync helpers: see
// public/spawnDialog.js. The returned handles are held in `spawnHandles` (declared
// above) so the Sidebar's onCreateInstanceClick, the Settings onModelsChange
// callback, and the boot-time loadModelVersions().then can forward to them.
spawnHandles = installSpawnDialog({
  dom: {
    spawnDialog: dom.spawnDialog,
    sdProject: dom.sdProject,
    sdModeCode: dom.sdModeCode,
    sdModePlan: dom.sdModePlan,
    sdEffort: dom.sdEffort,
    sdThinking: dom.sdThinking,
    sdWorktree: dom.sdWorktree,
    sdWorktreeHint: dom.sdWorktreeHint,
    sdTemp: dom.sdTemp,
    sdDebug: dom.sdDebug,
    sdError: dom.sdError,
    sdHookResult: dom.sdHookResult,
    sdHookSummary: dom.sdHookSummary,
    sdHookOutput: dom.sdHookOutput,
    sdSpawn: dom.sdSpawn,
    sdAdvanced: dom.sdAdvanced,
    conductBtn: dom.conductBtn,
    conductDialog: dom.conductDialog,
    cdModeCode: dom.cdModeCode,
    cdModePlan: dom.cdModePlan,
    cdError: dom.cdError,
  },
  getProjects: () => state.projects,
  refreshProjects,
  refreshInstances,
  selectInstance,
  closeSidebarOverflow,
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
} else {
  // Eagerly register the Service Worker even without notification permission.
  // Chrome only surfaces the "Install app" PWA entry once an active SW is
  // present; without this, the menu shows the weaker "Add to home screen"
  // (bookmark shortcut) instead.
  registerServiceWorker().catch(() => {});
}
renderNotifyToggle();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) closeAllOnFocus();
});
dom.sidebarScrim.addEventListener('click', () => setSidebarOpen(false));

// setSidebarStatus stays here — it also drives the anchor/auto-resume path
// (see the first-connect 'open' handler below) — and is injected into the
// restart flow, which now lives in restartFlow.js.
function setSidebarStatus(text, { warn = false } = {}) {
  if (!dom.sidebarStatus) return;
  dom.sidebarStatus.textContent = text;
  dom.sidebarStatus.classList.toggle('warn', !!warn && !!text);
}
// Restart-server button, its resume/plain confirm dialog, the
// POST → wait-for-server-back → reload sequence, and the background
// reconnect-status display. Placed here (before the first-connect 'open'
// handler ~below) so its 'open' listener registers first, preserving the
// original dispatch order.
installRestart({
  dom: { restartBtn: dom.restartBtn, restartDialog: dom.restartDialog, restartBlurb: dom.restartBlurb },
  bus,
  getInstances: () => state.instances,
  setSidebarStatus,
});

// Per-session / per-project action helpers (promote / resume / load-sessions /
// rewind / fork / delete-project / delete-session / remove-worktree) live in
// public/sessionActions.js. Returned handles are held in `sessionActions`
// (declared above) so the Sidebar callbacks, conversationOptions onRewind/onFork,
// the boot-time auto-resume, and the snapshot prefill-consume all forward to it.
// pendingPrefill is owned inside the module (set by forkActiveSession, read once
// by the snapshot handler via consumePendingPrefill).
const summaryHandle = installSessionSummary({
  dom,
  getActiveSid: () => {
    const inst = state.instances.find(i => i.id === state.activeId);
    return inst?.sessionId ?? null;
  },
});

sessionActions = installSessionActions({
  getActiveId: () => state.activeId,
  setActiveId: (v) => { state.activeId = v; },
  getInstances: () => state.instances,
  refreshProjects,
  refreshInstances,
  selectInstance,
  sidebar,
  clearUnread,
});

async function refreshProjects() {
  const [projects, workspaces, conductSessions] = await Promise.all([
    fetch('/api/projects').then(r => r.json()),
    fetch('/api/workspaces').then(r => r.json()).catch(() => []),
    fetch('/api/projects/.conduct/sessions').then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  state.projects = projects;
  sidebar.setProjects(projects);
  const names = Array.isArray(workspaces) ? workspaces.map(w => w.name).filter(Boolean) : [];
  sidebar.setWorkspaces(names);
  const count = Array.isArray(conductSessions) ? conductSessions.length : 0;
  const lastMtime = count > 0
    ? conductSessions.reduce((max, s) => Math.max(max, s.mtime ?? 0), 0)
    : 0;
  sidebar.setConductSessions({ count, lastMtime });
}
async function refreshInstances() {
  state.instances = await (await fetch('/api/instances')).json();
  sidebar.setInstances(state.instances);
  subagentPanel.setInstances(state.instances, state.activeId);
  headerHandle.update();
}

function selectInstance(id, opts = {}) {
  if (state.activeId && state.activeId !== id) send('unsubscribe', { id: state.activeId });
  state.activeId = id;
  sidebar.setActive(id);
  conversation.clear();
  lazyController.reset(); // invalidate any in-flight earlier-history fetch
  headerHandle.update();
  // Swap the task panel onto whichever instance just became active.
  taskPanel.attach(id ? getTracker(id) : null);
  subagentPanel.setInstances(state.instances, id);
  send('subscribe', { id });
  // Anchor the active session in the URL so a page refresh restores it.
  // Uses sessionId (stable across crash/resume), not the transient instance id.
  // pushState when navigating into a sub-agent so the back button can return
  // to the conductor; replaceState for all other navigation to avoid clutter.
  const leavingSettings = location.hash === '#settings';
  const leavingCommits  = location.hash === '#commits';
  const inst = id ? state.instances.find(i => i.id === id) : null;
  if (opts.push) {
    pushSessionAnchor(inst?.sessionId || null);
  } else {
    writeSessionAnchor(inst?.sessionId || null);
  }
  // Now that the user is viewing this session, any backlog of unread
  // turn-end pings for it is by definition read.
  clearUnread(inst?.sessionId);
  // If the user tapped a session from within the Settings or Commits page, close
  // that overlay so the conversation view is visible. writeSessionAnchor already
  // replaced the hash, so we check flags captured before that call.
  if (leavingSettings) settings.close();
  if (leavingCommits)  commits.close();
  if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false);
}

// Header ⋮ overflow menu — currently hosts the Debug button so it doesn't
// occupy primary-control real estate. Mirrors the usage popover's dismiss
// behavior (click outside / Escape).
const overflowCtl = makeDismissable({
  isInside: (t) => dom.overflowPanel.contains(t) || dom.overflowToggle.contains(t),
  onDismiss: () => closeOverflow(),
});
function closeOverflow() {
  if (!overflowCtl.armed) return;
  dom.overflowPanel.hidden = true;
  dom.overflowToggle.setAttribute('aria-expanded', 'false');
  overflowCtl.disarm();
}
function toggleOverflow() {
  if (overflowCtl.armed) { closeOverflow(); return; }
  dom.overflowPanel.hidden = false;
  dom.overflowToggle.setAttribute('aria-expanded', 'true');
  overflowCtl.arm();
}
dom.overflowToggle.addEventListener('click', toggleOverflow);

// Sidebar ≡ hamburger — mirrors the header overflow pattern. Hosts
// secondary project actions (currently just "+ Group") so the primary
// "+ New project" button gets the full action-row width.
const sidebarOverflowCtl = makeDismissable({
  isInside: (t) => dom.sidebarOverflowPanel.contains(t) || dom.sidebarOverflowToggle.contains(t),
  onDismiss: () => closeSidebarOverflow(),
});
function closeSidebarOverflow() {
  if (!sidebarOverflowCtl.armed) return;
  dom.sidebarOverflowPanel.hidden = true;
  dom.sidebarOverflowToggle.setAttribute('aria-expanded', 'false');
  sidebarOverflowCtl.disarm();
}
function toggleSidebarOverflow() {
  if (sidebarOverflowCtl.armed) { closeSidebarOverflow(); return; }
  dom.sidebarOverflowPanel.hidden = false;
  dom.sidebarOverflowToggle.setAttribute('aria-expanded', 'true');
  sidebarOverflowCtl.arm();
}
dom.sidebarOverflowToggle.addEventListener('click', toggleSidebarOverflow);

installExternalLinkOpener({
  beforeNavigate: () => stashCurrentAnchorForRelaunch(),
});

installLightbox();

// WS event router (public/wsRouter.js): the bus data/routing handlers
// (snapshot / reset_snapshot / event / turn_notification / status / instances /
// projects), the window 'popstate', and the first-connect 'open' anchor-restore
// / auto-resume. Wired LAST — after every module/handle/state above is
// constructed — so it injects resolved objects (no holder/forward-ref) and is a
// pure leaf consumer. Installed AFTER installRestart() so restart's 'open'
// listener stays registered before this router's 'open' listener (original
// dispatch order). `accountUsage` is NOT routed here — it stays in app.js.
installWsRouter({
  state,
  getTracker,
  getUsage,
  globalRLTracker,
  conversation,
  headerHandle,
  lazyController,
  sessionActions,
  composer,
  sidebar,
  subagentPanel,
  bumpUnread,
  flushPendingAnswers,
  refreshProjects,
  refreshInstances,
  selectInstance,
  setSidebarStatus,
});

connect();

refreshAccountUsage();
setInterval(refreshAccountUsage, 60_000);
