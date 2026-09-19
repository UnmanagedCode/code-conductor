// Frontend bootstrap. Loads projects + instances over REST, subscribes to
// instance updates over WebSocket, and wires the sidebar/composer to actions.

import { bus, connect, send } from './ws.js';
import { Sidebar } from './sidebar.js';
import { Conversation } from './conversation.js';
import { attachComposer, probeMicAvailability } from './composer.js';
import { formatUserQuestionAnswers, autoSpeakBlock } from './blocks.js';
import { TaskTracker, TaskPanel } from './tasks.js';
import { SubagentPanel } from './subagents.js';
import { UsageTracker, RateLimitTracker } from './usage.js';
import { restoreMutedSessions, installNotifyToggle } from './notifications.js';
import {
  writeSessionAnchor, pushSessionAnchor, stashCurrentAnchorForRelaunch,
} from './anchor.js';
import { installExternalLinkOpener } from './external-links.js';
import { makeDismissable } from './dismissable.js';
import { installLazyHistoryController } from './lazyHistory.js';
import { installLightbox } from './lightbox.js';
import { installSettings } from './settings.js';
import { installAppSwitcher } from './appSwitcher.js';
import { installPluginView } from './pluginView.js';
import { installReview } from './review.js';
import { installCommits } from './commits.js';
import { installCosts } from './costs.js';
import { installRestart } from './restartFlow.js';
import { installNewProjectDialog } from './newProjectDialog.js';
import { installAdoptProjectDialog } from './adoptProjectDialog.js';
import { installProjectRemoteDialog } from './projectRemoteDialog.js';
import { installWorkspaceDialog } from './workspaceDialog.js';
import { installSpawnDialog } from './spawnDialog.js';
import { installSessionActions } from './sessionActions.js';
import { installHeader } from './header.js';
import { installSessionSummary } from './sessionSummary.js';
import { installSessionStats } from './sessionStats.js';
import { installPruneDialog } from './pruneDialog.js';
import { installWsRouter } from './wsRouter.js';
import { latestOnly } from './latestOnly.js';
import { loadModelVersions,
  setActiveTierEnabled, setActiveDefaultSpawnTier, setActiveTierBackend, setActiveTierEffort, setDefaultEffort, setActiveRoleBindings, setBackends } from './models.js';
import { setTtsAvailable, setTtsEnabled, setTtsRate, probeTtsStatus } from './tts.js';
import { createUnreadStore } from './unread.js';
import { installAccountUsage } from './accountUsage.js';
import { installSidebarChrome } from './sidebarChrome.js';

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
  muteBtn: document.getElementById('mute-btn'),
  resumeBtn: document.getElementById('resume-btn'),
  instanceTitle: document.getElementById('instance-title'),
  taskPanel: document.getElementById('task-panel'),
  subagentPanel: document.getElementById('subagent-panel'),
  turnIndicator: document.getElementById('turn-indicator'),
  tiLeft: document.getElementById('ti-left'),
  tiDot: document.getElementById('ti-dot'),
  tiLabel: document.getElementById('ti-label'),
  tiEllipsis: document.getElementById('ti-ellipsis'),
  tiInterruptNow: document.getElementById('ti-interrupt-now'),
  tiUsageSlot: document.getElementById('ti-usage-slot'),
  newProjectBtn: document.getElementById('new-project-btn'),
  newProjectDialog: document.getElementById('new-project-dialog'),
  npName: document.getElementById('np-name'),
  npError: document.getElementById('np-error'),
  npPreview: document.getElementById('np-preview'),
  npContributions: document.getElementById('np-contributions'),
  npSystem: document.getElementById('np-system'),
  npSystemPath: document.getElementById('np-system-path'),
  npSystemPathRow: document.getElementById('np-system-path-row'),
  npRemote: document.getElementById('np-remote'),
  npRemoteRow: document.getElementById('np-remote-row'),
  projectRemoteDialog: document.getElementById('project-remote-dialog'),
  prProject: document.getElementById('pr-project'),
  prSystem: document.getElementById('pr-system'),
  prPath: document.getElementById('pr-path'),
  prRemote: document.getElementById('pr-remote'),
  prError: document.getElementById('pr-error'),
  prBlockers: document.getElementById('pr-blockers'),
  adoptProjectBtn: document.getElementById('adopt-project-btn'),
  adoptProjectDialog: document.getElementById('adopt-project-dialog'),
  apdForm: document.getElementById('apd-form'),
  apdStale: document.getElementById('apd-stale'),
  apdName: document.getElementById('apd-name'),
  apdPath: document.getElementById('apd-path'),
  apdSuggestions: document.getElementById('apd-suggestions'),
  apdScanNote: document.getElementById('apd-scan-note'),
  apdError: document.getElementById('apd-error'),
  apdStaleSummary: document.getElementById('apd-stale-summary'),
  apdStaleDiscards: document.getElementById('apd-stale-discards'),
  apdStaleError: document.getElementById('apd-stale-error'),
  npForm: document.getElementById('np-form'),
  npConfirm: document.getElementById('np-confirm'),
  npScaffoldText: document.getElementById('np-scaffold-text'),
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
  syncBtn: document.getElementById('sync-btn'),
  mergeBtn: document.getElementById('merge-btn'),
  debugBtn: document.getElementById('debug-btn'),
  summarizeSessionBtn: document.getElementById('summarize-session-btn'),
  summaryDialog: document.getElementById('summary-dialog'),
  renameSessionBtn: document.getElementById('rename-session-btn'),
  changeModelBtn: document.getElementById('change-model-btn'),
  changeEffortBtn: document.getElementById('change-effort-btn'),
  sessionStatsBtn: document.getElementById('session-stats-btn'),
  statsDialog: document.getElementById('stats-dialog'),
  pruneSessionBtn: document.getElementById('prune-session-btn'),
  pruneDialog: document.getElementById('prune-dialog'),
  autoApprovePlanBtn: document.getElementById('auto-approve-plan-btn'),
  playbookEnforcementBtn: document.getElementById('playbook-enforcement-btn'),
  overflowMenu: document.getElementById('overflow-menu'),
  overflowToggle: document.getElementById('overflow-toggle'),
  overflowPanel: document.getElementById('overflow-panel'),
  sidebarOverflowMenu: document.getElementById('sidebar-overflow-menu'),
  sidebarOverflowToggle: document.getElementById('sidebar-overflow-toggle'),
  sidebarOverflowPanel: document.getElementById('sidebar-overflow-panel'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebar: document.getElementById('sidebar'),
  sidebarScrim: document.getElementById('sidebar-scrim'),
  sidebarResizeHandle: document.getElementById('sidebar-resize-handle'),
  notifyToggle: document.getElementById('notify-toggle'),
  restartBtn: document.getElementById('restart-server-btn'),
  sidebarStatus: document.getElementById('sidebar-status'),
  restartDialog: document.getElementById('restart-dialog'),
  restartBlurb: document.getElementById('rd-blurb'),
};

// Sidebar chrome: the mobile drawer (toggle + scrim), the desktop column's
// drag-resize handle and persisted width, and the ≡ overflow menu (see
// public/sidebarChrome.js). Installed here, immediately after the dom map,
// because closeSidebarOverflow is passed BY VALUE into installNewProjectDialog
// and installSpawnDialog below — as a handle method it has to already exist.
// Only the two navigation helpers are forwarded: every setSidebarOpen call
// site moved into the module with the toggle and scrim listeners.
const { closeSidebarOnMobile, closeSidebarOverflow } = installSidebarChrome({ dom });

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

// The periodic /api/usage poll and its merge of the tightest rate-limit bucket
// into globalRLTracker live in public/accountUsage.js. headerUpdate is a lazy
// arrow because headerHandle is assigned further down.
const accountUsage = installAccountUsage({
  globalRLTracker,
  getActiveId: () => state.activeId,
  headerUpdate: () => headerHandle.update(),
});

// Auto-approve-plan toggle now lives on the server (per Instance) and
// the flag is mirrored down through `snapshot` / `status` frames into
// each entry of `state.instances`. The client just renders the synced
// state and sends a WS message on toggle; the server is the one that
// actually approves the plan when an ExitPlanMode lands. This makes the
// toggle work even when the tab isn't focused on the affected session
// or is backgrounded entirely.

// Per-sessionId unread counts + their localStorage persistence live in
// public/unread.js. Constructed before the Sidebar because the Sidebar seed
// below reads `unread.counts`; onChange is a lazy arrow for the same reason
// the other holders are (it only fires after init, so the `const sidebar` TDZ
// is never reached).
const unread = createUnreadStore({ onChange: (m) => sidebar.setUnread(m) });

// Deliver a card answer (AskUserQuestion / plan Approve-Reject) as a normal
// user turn — the same ungated send the composer uses. Mid-turn is the NORMAL
// case, not an edge: the can_use_tool deny only ends the turn if the CLI has
// nothing queued behind it, and in a conductor session a wake callback already
// sitting in stdin keeps the same turn running while the human reads the card.
// The server routes it through Instance.promptOrQueueSteer (src/wsHub.ts), which
// prepends a note as its own content block so the answer text stays byte-identical
// either way: MID_TURN_NOTE on a live mid-turn send, or POST_STOP_STEER_NOTE when
// the worker's model cannot take one and the answer is parked behind a block-edge
// stop and delivered as a fresh turn.
//
// Sent with `ack` so a send that never reaches the CLI — socket reconnecting,
// instance killed, session mid-rewind — can unlock the card instead of leaving
// it asserting `sending…` forever. `onFail` re-opens the card; there is no
// retry or persistence by design.
// The ack's 10s timeout can't unlock a card that DID send: the ack is written in
// the same tick as the send, BEFORE any wait on delivery. On the parked route the
// user_echo arrives only when the steer flushes at the block edge — which is
// exactly why the ack must not wait on the send.
function sendCardAnswer(instanceId, text, onFail) {
  send('prompt', { id: instanceId, text }, { ack: true })
    .catch((e) => onFail(e?.message || 'send failed'));
}

// Handles returned by installSessionActions ({ promoteSession, loadSessions,
// resumeSession, rewindActiveSession, forkActiveSession, deleteProject,
// deleteSession, removeWorktree }). Declared here —
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
  onUserQuestionSubmit: ({ toolUseId, questions, answers }) => {
    if (!state.activeId) return;
    // The CLI auto-errors AskUserQuestion in stream-json mode, so the
    // consolidated answers go back as a single normal prompt — sent live,
    // whatever the instance's status (see sendCardAnswer).
    sendCardAnswer(
      state.activeId,
      formatUserQuestionAnswers(questions, answers),
      (reason) => conversation.userQuestionBlocks.get(toolUseId)?.markSendFailed(reason),
    );
  },
  onPermissionDecision: ({ toolUseId, allow }) => {
    if (!state.activeId) return;
    // Forward the Allow/Deny click to the orchestrator over WS. The
    // server resolves the held-open PreToolUse hook HTTP response and
    // the CLI then either runs the tool or auto-denies it.
    send('hook_decision', { id: state.activeId, toolUseId, allow });
  },
  onPlanDecision: async ({ toolUseId, decision, feedback }) => {
    if (!state.activeId) return;
    const activeId = state.activeId;
    const onFail = (reason) => conversation.planBlocks.get(toolUseId)?.markSendFailed(reason);
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
      sendCardAnswer(activeId, text, onFail);
    } else {
      const text = feedback
        ? `I'd like to revise the plan. Refinement notes:\n${feedback}`
        : `I'd like to revise the plan. Please refine it.`;
      sendCardAnswer(activeId, text, onFail);
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
// Handles returned by installSpawnDialog ({ openSpawnDialog, syncTierModelLabels,
// syncTierVisibility }). Declared before the Sidebar/Settings installs so their
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
// after the next unread.bump fires.
sidebar.setUnread(unread.counts);
// Rehydrate per-session notification mutes so the header's Mute/Unmute
// item reflects the right state on the first render after a page reload.
restoreMutedSessions();

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

// Per-session / per-project action helpers (promote / resume / load-sessions /
// rewind / fork / delete-project / delete-session / remove-worktree, plus the
// session-title PUT and the worktree sync/merge/respawn ops) live in
// public/sessionActions.js. Returned handles are held in `sessionActions`
// (declared above) so the Sidebar callbacks, conversationOptions onRewind/onFork,
// and the boot-time auto-resume all forward to it. Fork/rewind composer prefill
// rides `droppedText` inline on the WS snapshot/reset_snapshot frame (handled in
// wsRouter.js) — no client-side prefill state lives in sessionActions.
//
// Installed BEFORE installHeader because the header's control handlers call
// into it. It is a pure closure factory with no install-time side effects, and
// its own deps are either already constructed (sidebar) or hoisted declarations
// / lazy arrows, so moving it up is safe.
sessionActions = installSessionActions({
  getActiveId: () => state.activeId,
  setActiveId: (v) => { state.activeId = v; },
  getInstances: () => state.instances,
  refreshProjects,
  refreshInstances,
  selectInstance,
  sidebar,
  clearUnread: unread.clear,
  headerUpdate: () => headerHandle.update(),
  deleteProjectDom: {
    dialog: document.getElementById('delete-project-dialog'),
    title: document.getElementById('dpd-title'),
    summary: document.getElementById('dpd-summary'),
    effects: document.getElementById('dpd-effects'),
    dirRow: document.getElementById('dpd-dir-row'),
    deleteDir: document.getElementById('dpd-delete-dir'),
    dirLabel: document.getElementById('dpd-dir-label'),
    confirm: document.getElementById('dpd-confirm'),
    error: document.getElementById('dpd-error'),
  },
});

// Active-instance header / chips / combined-usage popover (see public/header.js).
// Wired here once composer + conversation exist.
// getAccountUsage is a getter so the chip always renders whatever the periodic
// /api/usage poll last stored. setActiveStatus/setActiveMode/getActiveStatus
// mirror onto and read back from the same live `state` object.
headerHandle = installHeader({
  dom,
  getActiveId: () => state.activeId,
  getInstances: () => state.instances,
  setActiveStatus: (v) => { state.activeStatus = v; },
  setActiveMode: (v) => { state.activeMode = v; },
  getActiveStatus: () => state.activeStatus,
  getUsage,
  globalRLTracker,
  getAccountUsage: () => accountUsage.get(),
  getAccountUsageStale: () => accountUsage.isStale(),
  composer,
  conversation,
  sessionActions,
  // The three dialog handles are built after this install, so they arrive lazily.
  openSummary: () => summaryHandle.open(),
  openStats: () => statsHandle.open(),
  openPrune: () => pruneHandle.open(),
});

// Enable the Send button's hold-to-record mic affordance only when the
// server has whisper.cpp + the model on disk. The Settings page can flip
// availability at runtime (install / model switch), so this is also called
// via onAvailabilityChange below.
function setMicAvailable(available) {
  composer.setMicAvailable(available);
}
probeMicAvailability(setMicAvailable);
probeTtsStatus();

// Settings page (full-page view at #settings). The burger-menu button routes
// here; closing restores the previously-active session anchor.
function closeSettings() {
  const inst = state.instances.find(i => i.id === state.activeId);
  writeSessionAnchor(inst?.sessionId || null);
}
// App switcher (sidebar header dropdown) + plugin iframe view. The switcher
// re-fetches the catalog after any pluginManager action via onPluginsChanged
// and re-syncs its selection after every plugin-view teardown (onClosed),
// which reads location.hash to decide Conductor vs a plugin. Settings and
// review navigate via a plain `location.hash =` assignment, which fires
// hashchange BEFORE pluginView's own listener tears it down — hash is
// already correct by the time sync() runs. replaceState/pushState-based
// navigation (this Conductor entry; commits open, below) fires no
// hashchange, so those paths close the plugin view explicitly — and MUST
// update the hash first, or sync() reads the stale `#plugin/...` hash and
// re-selects the plugin (see selectInstance's session-select path, which
// gets this ordering right already). onShown fires on entry into the plugin
// space (dropdown select, deep link, boot) AND on a plugin-to-plugin switch
// — collapse the mobile drawer there too, same idiom as selectInstance
// revealing a session.
let appSwitcher = null;
const pluginView = installPluginView({
  onClosed: () => appSwitcher?.sync(),
  onShown: () => closeSidebarOnMobile(),
});
appSwitcher = installAppSwitcher({
  onExitToConductor: () => {
    const inst = state.instances.find(i => i.id === state.activeId);
    writeSessionAnchor(inst?.sessionId || null);
    pluginView.close();
    closeSidebarOnMobile();
  },
});
// Assigned later by installRestart() (called after this block); the
// self-update flow only invokes it on a user click, long after wiring.
let restartHandle = null;
const settings = installSettings({
  requestClose: closeSettings,
  onAvailabilityChange: setMicAvailable,
  onPluginsChanged: () => appSwitcher.refresh(),
  // Self-update hands off to the shared restart+resume engine after its pull
  // succeeds — resume carries live sessions across the respawn.
  requestRestartWithResume: () => restartHandle?.performRestart({ resume: true }),
  onModelsChange: data => {
    if (data.tierBackend) setActiveTierBackend(data.tierBackend);
    setDefaultEffort(data.defaultEffort);
    if (data.tierEffort) setActiveTierEffort(data.tierEffort);
    if (data.roleBackend) setActiveRoleBindings(data.roleBackend);
    if (data.enabledTiers) setActiveTierEnabled(data.enabledTiers);
    setActiveDefaultSpawnTier(data.defaultSpawnTier);
    setBackends(data.backends);
    spawnHandles.syncTierModelLabels();
    spawnHandles.syncTierVisibility();
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
  // Jump straight to the restored session: resumeSession() spawns/attaches
  // the instance and selects it, which closes Settings automatically
  // (selectInstance() detects location.hash === '#settings').
  onSessionRestored: ({ project, worktreeName, sessionId }) =>
    sessionActions.resumeSession({ projectName: project, worktreeName, sessionId }),
});
// Seed the per-tier/per-backend model-version cache the spawn pickers resolve against.
// headerHandle.update() too: the header's tier and backend LABELS come from this
// payload (getTierLabel / getBackendLabel), so a header painted from the WS
// snapshot shows raw ids until it re-renders. The ctx denominator does NOT come
// from here — it rides on the instance summary as `contextWindowTokens`.
loadModelVersions().then(() => {
  spawnHandles.syncTierModelLabels();
  spawnHandles.syncTierVisibility();
  headerHandle.update();
});
dom.settingsBtn?.addEventListener('click', () => {
  closeSidebarOverflow();
  if (location.hash === '#settings') settings.close();
  else {
    closeSidebarOnMobile();
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
  closeSidebarOnMobile();
  review.open({
    title: `${project} / ${wt}`,
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
sidebar.onShowCommits = (project, worktree) => {
  closeSidebarOnMobile();
  // commits opens via pushState (no hashchange — unlike review's hash
  // assignment), so the plugin view must be closed explicitly or the two
  // full-page sections stack. Open commits FIRST so the hash already reads
  // '#commits' by the time close() fires the switcher's re-sync — otherwise
  // sync() reads the still-stale '#plugin/...' hash and re-selects the plugin.
  commits.open(project, worktree);
  pluginView.close();
};
// Every row hands out its own diffUrl (commits.js), so the (project, worktree)
// spelling has exactly one home.
commits.onOpenCommit = (project, c) => {
  review.open({
    title: c.sha ? `${c.shortSha} ${c.subject}` : c.subject,
    url: c.diffUrl,
  });
};

// Cost dashboard (opened from Settings → Models → "Cost dashboard" button).
const costs = installCosts({ onClose: () => {
  const inst = state.instances.find(i => i.id === state.activeId);
  writeSessionAnchor(inst?.sessionId || null);
} });

installNewProjectDialog({
  dom: {
    newProjectBtn: dom.newProjectBtn,
    newProjectDialog: dom.newProjectDialog,
    npName: dom.npName,
    npError: dom.npError,
    npPreview: dom.npPreview,
    npContributions: dom.npContributions,
    npSystem: dom.npSystem,
    npSystemPath: dom.npSystemPath,
    npSystemPathRow: dom.npSystemPathRow,
    npRemote: dom.npRemote,
    npRemoteRow: dom.npRemoteRow,
    npForm: dom.npForm,
    npConfirm: dom.npConfirm,
    npScaffoldText: dom.npScaffoldText,
  },
  refreshProjects,
  closeSidebarOverflow,
});

// Adopt-directory dialog: see public/adoptProjectDialog.js. The sidebar's only
// route into POST /api/projects/external.
installAdoptProjectDialog({
  dom: {
    adoptProjectBtn: dom.adoptProjectBtn,
    adoptProjectDialog: dom.adoptProjectDialog,
    apdForm: dom.apdForm,
    apdStale: dom.apdStale,
    apdName: dom.apdName,
    apdPath: dom.apdPath,
    apdSuggestions: dom.apdSuggestions,
    apdScanNote: dom.apdScanNote,
    apdError: dom.apdError,
    apdStaleSummary: dom.apdStaleSummary,
    apdStaleDiscards: dom.apdStaleDiscards,
    apdStaleError: dom.apdStaleError,
  },
  refreshProjects,
  closeSidebarOverflow,
});

// Change-target dialog: see public/projectRemoteDialog.js. Opened from the
// sidebar's system pill, which is the one place on the page that already says
// which target a project is on.
const projectRemoteHandles = installProjectRemoteDialog({
  dom: {
    projectRemoteDialog: dom.projectRemoteDialog,
    prProject: dom.prProject,
    prSystem: dom.prSystem,
    prPath: dom.prPath,
    prRemote: dom.prRemote,
    prError: dom.prError,
    prBlockers: dom.prBlockers,
  },
  refreshProjects,
});
sidebar.onEditProjectRemote = (project) => projectRemoteHandles.open(project);

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

// Spawn dialog + Conduct button handler and the model-picker sync helpers: see
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
  },
  getProjects: () => state.projects,
  refreshProjects,
  refreshInstances,
  selectInstance,
  closeSidebarOverflow,
});

// The 🔔/🔕 toggle, its boot permission/SW bootstrap and the focus-dismiss
// listener live in public/notifications.js.
installNotifyToggle({ dom });

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
restartHandle = installRestart({
  dom: { restartBtn: dom.restartBtn, restartDialog: dom.restartDialog, restartBlurb: dom.restartBlurb },
  bus,
  getInstances: () => state.instances,
  setSidebarStatus,
});

const getActiveSid = () => {
  const inst = state.instances.find(i => i.id === state.activeId);
  return inst?.sessionId ?? null;
};
const summaryHandle = installSessionSummary({ dom, getActiveSid, applySessionTitle: sessionActions.applySessionTitle });
const statsHandle = installSessionStats({ dom, getActiveSid });
const pruneHandle = installPruneDialog({
  dom, getActiveId: () => state.activeId, refreshInstances,
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
  const lastActivity = count > 0
    ? conductSessions.reduce((max, s) => Math.max(max, s.lastActivity ?? 0), 0)
    : 0;
  sidebar.setConductSessions({ count, lastActivity });
}
const instancesGuard = latestOnly();
async function refreshInstances() {
  await instancesGuard(
    () => fetch('/api/instances').then(r => r.json()),
    (data) => {
      state.instances = data;
      sidebar.setInstances(state.instances);
      subagentPanel.setInstances(state.instances, state.activeId);
      headerHandle.update();
    },
  );
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
  const leavingPlugin   = location.hash.startsWith('#plugin/');
  const inst = id ? state.instances.find(i => i.id === id) : null;
  if (opts.push) {
    pushSessionAnchor(inst?.sessionId || null);
  } else {
    writeSessionAnchor(inst?.sessionId || null);
  }
  // Now that the user is viewing this session, any backlog of unread
  // turn-end pings for it is by definition read.
  unread.clear(inst?.sessionId);
  // If the user tapped a session from within the Settings or Commits page, close
  // that overlay so the conversation view is visible. writeSessionAnchor already
  // replaced the hash, so we check flags captured before that call.
  if (leavingSettings) settings.close();
  if (leavingCommits)  commits.close();
  if (leavingPlugin)   pluginView.close();
  closeSidebarOnMobile();
}

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
// dispatch order). `accountUsage` is NOT routed here — it polls over REST
// (public/accountUsage.js).
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
  bumpUnread: unread.bump,
  refreshProjects,
  refreshInstances,
  selectInstance,
  setSidebarStatus,
});

connect();

accountUsage.refresh();
setInterval(() => accountUsage.refresh(), 180_000);

// Keep the turn-indicator's idle "last response Xm ago" label ticking
// without a network round-trip or a full header rebuild (tickIdleAgo is a
// no-op mid-turn and while no instance is active).
setInterval(() => headerHandle.tickIdleAgo(), 15_000);

// Same fix for the sidebar's per-session "Xs/Xm ago" labels, which were
// otherwise frozen at whatever formatAgo() returned during the last
// data-triggered render (see Sidebar.tickAgo).
setInterval(() => sidebar.tickAgo(), 15_000);
