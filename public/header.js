// Active-instance header: the chip row (title / project / worktree / status /
// temp / debug / auto-resume), the primary controls (mode select, kill/resume,
// sync/merge, overflow + auto-approve buttons), the composer/turn-indicator
// enablement, and the combined context+rate-limit chip with its usage popover.
//
// Extracted from app.js (slice 8). app.js stays the orchestrator: it owns
// `state`, the dom singleton, the per-instance usage trackers (`getUsage`), the
// account-wide `globalRLTracker`, the `accountUsage` fetch, the overflow menu
// (`closeOverflow`), and the WS router + control handlers. It holds the handle
// returned here in a `headerHandle` holder and forwards every `updateActiveHeader`
// call site through `headerHandle.update()`.
//
// The combined chip + popover builders have NO external callers — they are
// reached only from inside update()'s render flow (the chip's click handler
// cascades into toggle → build → close). So this module exposes a single
// external handle: `update`.
//
// Injected interface:
//   - dom:               the live dom singleton (header reads ~16 elements off it).
//   - getActiveId()/getInstances(): read state.activeId / state.instances.
//   - setActiveStatus(v)/setActiveMode(v): mirror status/mode back onto the SAME
//                        live `state` object (activeStatus is read by app.js's
//                        killBtn handler, so it must hit the shared object).
//   - getUsage(id):      the per-instance UsageTracker (STAYS in app.js — the WS
//                        snapshot/event handlers use it too).
//   - globalRLTracker:   the account-wide RateLimitTracker singleton.
//   - getAccountUsage(): reads the `accountUsage` let (reassigned by the periodic
//                        /api/usage fetch) — a getter so the chip/popover always
//                        render the current value, identical to the old closure.
//   - getAccountUsageStale(): true when the current accountUsage value was served
//                        stale by the server (backoff/failure window) rather than
//                        freshly fetched — drives the popover's "(stale)" suffix.
//   - composer/conversation: enablement toggles.
//   - closeOverflow():   the header ⋮ menu close (overflow controller STAYS in app.js).

import {
  contextWindowFor, formatTokens, formatPct, formatDuration,
  fillClass, formatResetTime, formatAutoResumeTime, rlChipSegment,
} from './usage.js';
import { makeDismissable } from './dismissable.js';

// Combined popover: "Session totals" section above, "Usage limits" section
// below. ctx data is per-session; usage-limit data is account-wide.
const OAUTH_BUCKET_LABELS = {
  five_hour:        '5-hour',
  seven_day:        '7-day',
  seven_day_sonnet: '7-day (Sonnet)',
  seven_day_opus:   '7-day (Opus)',
};

export function installHeader({
  dom,
  getActiveId,
  getInstances,
  setActiveStatus,
  setActiveMode,
  getUsage,
  globalRLTracker,
  getAccountUsage,
  getAccountUsageStale,
  composer,
  conversation,
  closeOverflow,
}) {
  let openCombinedPopover = null;

  function closeCombinedPopover() {
    if (!openCombinedPopover) return;
    const { node, anchor, ctl } = openCombinedPopover;
    node.remove();
    anchor.setAttribute('aria-expanded', 'false');
    ctl.disarm();
    openCombinedPopover = null;
  }

  function toggleCombinedPopover(anchor, inst) {
    if (openCombinedPopover && openCombinedPopover.anchor === anchor) {
      closeCombinedPopover();
      return;
    }
    closeCombinedPopover();
    const node = buildCombinedPopover(inst);
    document.body.appendChild(node);
    // Position above the chip — the bar is at the bottom of the viewport.
    const r = anchor.getBoundingClientRect();
    node.style.top = `${Math.round(r.top - node.offsetHeight - 6)}px`;
    const desiredLeft = r.right - node.offsetWidth;
    const maxLeft = window.innerWidth - node.offsetWidth - 8;
    node.style.left = `${Math.max(8, Math.min(desiredLeft, maxLeft))}px`;
    anchor.setAttribute('aria-expanded', 'true');
    // node/anchor differ per open, so the controller is created per-open
    // (mirrors the original, which defined `dismiss` inside this function).
    const ctl = makeDismissable({
      isInside: (t) => node.contains(t) || anchor.contains(t),
      onDismiss: () => closeCombinedPopover(),
    });
    ctl.arm();
    openCombinedPopover = { node, anchor, ctl };
  }

  function buildCombinedPopover(inst) {
    const accountUsage = getAccountUsage();
    const node = document.createElement('div');
    node.className = 'ih-usage-popover';
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', 'Usage details');

    const row = (label, value, valueClass) => {
      const r = document.createElement('div'); r.className = 'ih-usage-row';
      const k = document.createElement('span'); k.className = 'ih-usage-k'; k.textContent = label;
      const v = document.createElement('span'); v.className = 'ih-usage-v';
      if (valueClass) v.classList.add(valueClass);
      v.textContent = value;
      r.appendChild(k); r.appendChild(v);
      return r;
    };
    const section = (title) => {
      const h = document.createElement('div');
      h.className = 'ih-usage-popover-header';
      h.textContent = title;
      return h;
    };

    // ── Session totals ──
    node.appendChild(section('Session totals'));
    const usage = getUsage(inst.id);
    const c = usage.cum;
    const ctxWindow = contextWindowFor(usage.effectiveModel(inst.model));
    const modelLabel = usage.effectiveModel(inst.model) ?? '(default)';
    const meta = document.createElement('div');
    meta.className = 'ih-usage-meta';
    meta.textContent = `${modelLabel} · ${formatTokens(ctxWindow)} context`;
    node.appendChild(meta);
    if (c.turns === 0) {
      const empty = document.createElement('div');
      empty.className = 'ih-usage-empty-msg';
      empty.textContent = 'No turns have completed yet.';
      node.appendChild(empty);
    } else {
      const totalCacheIn = c.cacheRead + c.cacheCreation;
      const totalIn = c.inputTokens + totalCacheIn;
      const cacheHit = totalIn > 0 ? c.cacheRead / totalIn : 0;
      node.appendChild(row('Turns', String(c.turns)));
      node.appendChild(row('Duration', formatDuration(c.durationMs)));
      node.appendChild(row('Cost', `$${c.cost.toFixed(4)}`));
      node.appendChild(row('Input (uncached)', formatTokens(c.inputTokens)));
      node.appendChild(row('Output', formatTokens(c.outputTokens)));
      node.appendChild(row('Cache reads', `${formatTokens(c.cacheRead)} (${formatPct(cacheHit)} hit)`));
      node.appendChild(row('Cache creation', formatTokens(c.cacheCreation)));
    }

    // ── Usage limits ──
    const usageLimitsGap = document.createElement('div');
    usageLimitsGap.className = 'ih-usage-section-gap';
    node.appendChild(usageLimitsGap);
    node.appendChild(section(accountUsage && getAccountUsageStale() ? 'Usage limits (stale)' : 'Usage limits'));
    if (!accountUsage) {
      const empty = document.createElement('div');
      empty.className = 'ih-usage-empty-msg';
      empty.textContent = 'Usage data unavailable.';
      node.appendChild(empty);
    } else {
      for (const key of ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus']) {
        const bucket = accountUsage[key];
        if (!bucket) continue;
        const label = OAUTH_BUCKET_LABELS[key] ?? key;
        const util = typeof bucket.utilization === 'number' ? bucket.utilization / 100 : null;
        const reset = bucket.resets_at
          ? formatResetTime(new Date(bucket.resets_at).getTime() / 1000)
          : null;
        const utilStr = util != null ? `${Math.round(util * 100)}%` : '—';
        const resetStr = reset ? ` · ${reset}` : '';
        node.appendChild(row(label, utilStr + resetStr, fillClass(util)));
      }
      const ex = accountUsage.extra_usage;
      if (ex?.is_enabled) {
        const used = typeof ex.used_credits === 'number' ? (ex.used_credits / 100).toFixed(2) : '?';
        const limit = typeof ex.monthly_limit === 'number' ? (ex.monthly_limit / 100).toFixed(2) : '?';
        const currency = ex.currency ?? '';
        node.appendChild(row('Extra credits', `${used} / ${limit} ${currency}`.trim()));
      }
    }

    return node;
  }

  // Combined ctx + rl chip. ctx half is per-session; rl half reads from
  // globalRLTracker (account-wide) with accountUsage as a fallback source.
  // Color-graded by the worse of the two fractions so a near-limit rate-limit
  // turns the chip amber/red even when context usage is low.
  function renderCombinedChip(inst) {
    const accountUsage = getAccountUsage();
    // ── ctx half ──
    const usage = getUsage(inst.id);
    const ctxFrac = usage.currentFillPct(inst.model);
    const ctxUsed = usage.currentContextSize();
    const ctxWindow = contextWindowFor(usage.effectiveModel(inst.model));

    let ctxText;
    if (ctxUsed == null) {
      ctxText = 'ctx —';
    } else {
      ctxText = `ctx ${formatPct(ctxFrac)} · ${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}`;
    }

    // ── rl half (global) — pure derivation via rlChipSegment ──
    const { text: rlText, frac: rlFrac, isOverage: rlIsOverage } =
      rlChipSegment(globalRLTracker.info, accountUsage);

    // Chip color is driven solely by context usage, not rate-limit %.
    const worstFrac = ctxFrac;

    const el = document.createElement('button');
    el.type = 'button';
    el.className = `ih-chip ih-combined ${fillClass(worstFrac)}`;
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('aria-expanded', 'false');
    el.title = [
      ctxUsed != null
        ? `Context: ${ctxUsed.toLocaleString()}/${ctxWindow.toLocaleString()} tokens`
        : 'Context usage appears after the first turn.',
      rlFrac != null ? `Rate limit: ${Math.round(rlFrac * 100)}% used` : null,
      rlIsOverage ? 'OVERAGE active' : null,
      'Tap for details',
    ].filter(Boolean).join(' · ');

    el.textContent = `${ctxText} · ${rlText}`;
    if (rlIsOverage) {
      const badge = document.createElement('span');
      badge.className = 'rl-overage-badge';
      badge.textContent = 'OVERAGE';
      el.appendChild(badge);
    }

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCombinedPopover(el, inst);
    });
    return el;
  }

  function update() {
    // The header gets rebuilt from scratch on every call, which discards
    // the existing chip nodes. Close any open popover first so it's not
    // left hanging off a detached anchor.
    closeCombinedPopover();
    closeOverflow();
    const inst = getInstances().find(i => i.id === getActiveId());
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
    setActiveStatus(inst.status);
    setActiveMode(inst.mode);
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
    // Custom session title (set via ⋮ → Rename session) leads the chip row
    // when present, so the human label is the first thing the user reads.
    if (inst.title) {
      const titleChip = chip('ih-title', inst.title);
      titleChip.title = 'custom session title — change via ⋮ → Rename session';
      dom.instanceTitle.appendChild(titleChip);
    }
    // Project chip carries the full session id as a tooltip — long-press on
    // mobile / hover on desktop — instead of taking a dedicated header chip.
    const projectChip = chip('ih-project', inst.project);
    projectChip.title = `session ${inst.sessionId ?? '?'}`;
    dom.instanceTitle.appendChild(projectChip);
    if (inst.worktree?.worktreeName) {
      const wtShort = inst.worktree.worktreeName.replace(`${inst.project}_worktree_`, 'wt:');
      dom.instanceTitle.appendChild(chip('ih-worktree',
        `${wtShort} (← ${inst.worktree.baseBranch})`));
    }
    // Status chip only when it's signalling something actionable. `idle` is
    // the no-op state; turn / spawning / crashed / exited / running (a
    // background subagent is still working) still surface. A soft interrupt
    // mid-turn shows a distinct "stopping…" chip. Cosmetic only — the real
    // `inst.status` (not `displayStatus`) still gates every action below.
    if (inst.status === 'turn' && inst.interrupting) {
      dom.instanceTitle.appendChild(chip('ih-status ih-status-interrupting', 'stopping…'));
    } else if (inst.displayStatus !== 'idle') {
      dom.instanceTitle.appendChild(chip(`ih-status ih-status-${inst.displayStatus}`, inst.displayStatus));
    }
    if (inst.temp) dom.instanceTitle.appendChild(chip('ih-temp', 'temp'));
    if (inst.debug) dom.instanceTitle.appendChild(chip('ih-debug', 'debug'));
    // Overage paused chip. armed (autoResumeAt) shows the resume time + queued
    // count; a not-yet-queued session paused by the GLOBAL window (overageActive,
    // no armed deadline yet) shows a bare "paused" chip off overageResetsAt.
    if (inst.autoResumeAt) {
      const n = inst.queuedCount || 0;
      const label = formatAutoResumeTime(inst.autoResumeAt) + (n > 0 ? ` · ${n} queued` : '');
      const rc = chip('ih-status ih-auto-resume', label);
      rc.title = n > 0
        ? `auto-stopped on overage — ${n} message${n === 1 ? '' : 's'} queued; will resume when the window resets`
        : 'auto-stopped on overage — will resume when the rate-limit window resets';
      dom.instanceTitle.appendChild(rc);
    } else if (inst.overageActive) {
      const rc = chip('ih-status ih-auto-resume',
        formatAutoResumeTime(inst.overageResetsAt) || 'paused');
      rc.title = 'rate-limit window active — messages are queued until it resets';
      dom.instanceTitle.appendChild(rc);
    }
    // Combined ctx+rl chip: right slot of the bottom bar. ctx half is
    // per-session; rl half reads from globalRLTracker (account-wide).
    dom.tiUsageSlot.textContent = '';
    dom.tiUsageSlot.appendChild(renderCombinedChip(inst));
    dom.modeSelect.value = inst.mode;
    dom.modeSelect.disabled = inst.status === 'turn' || inst.status === 'crashed' || inst.status === 'exited';
    dom.killBtn.textContent = inst.status === 'turn' ? '⏸ Interrupt' : '🛑 Terminate';
    dom.killBtn.disabled = !['idle', 'turn', 'spawning'].includes(inst.status);
    dom.resumeBtn.hidden = !(inst.status === 'crashed' || inst.status === 'exited');
    dom.turnIndicator.hidden = false;
    dom.tiLeft.hidden = inst.status !== 'turn';
    const interrupting = inst.status === 'turn' && !!inst.interrupting;
    dom.tiLabel.textContent = interrupting ? 'Stopping…' : 'Claude is working';
    dom.tiInterruptNow.hidden = !interrupting;
    const hasWorktree = !!inst.worktree?.worktreeName;
    dom.syncBtn.hidden = !hasWorktree;
    dom.syncBtn.disabled = !hasWorktree;
    dom.mergeBtn.hidden = !hasWorktree;
    dom.mergeBtn.disabled = !hasWorktree;
    // Overflow menu (⋮) hosts secondary actions: Interrupt/Kill + Debug
    // capture. The whole trigger is hidden when no items apply (i.e. the
    // instance isn't alive). Debug button: shown while alive; once enabled
    // it flips to a disabled '🐛 capturing' indicator — there's no off
    // path (the CLI stays mirrored for the rest of its life). Auto-approve
    // plans lives in the controls row (sibling of #mode-select), not in
    // this menu, so the toggle is one click from anywhere — including
    // mid-turn.
    const canMenu = ['idle', 'turn', 'spawning'].includes(inst.status);
    dom.debugBtn.hidden = !canMenu;
    dom.renameSessionBtn.hidden = !canMenu;
    dom.renameSessionBtn.disabled = !canMenu || !inst.sessionId;
    // Auto-approve only applies to plan mode (it short-circuits the
    // ExitPlanMode confirmation card). Hide it in code/ask mode so the
    // controls row stays uncluttered.
    const showAutoApprove = canMenu && inst.mode === 'plan';
    dom.autoApprovePlanBtn.hidden = !showAutoApprove;
    dom.autoApprovePlanBtn.disabled = !showAutoApprove;
    dom.overflowMenu.hidden = !canMenu;
    if (inst.debug) {
      dom.debugBtn.textContent = '🐛 capturing';
      dom.debugBtn.disabled = true;
      dom.debugBtn.title = `mirroring to ${inst.debugDir ?? '(unknown path)'}`;
    } else {
      dom.debugBtn.textContent = '🐛 Debug';
      dom.debugBtn.disabled = false;
      dom.debugBtn.title = 'Start mirroring CLI stdin/stdout/stderr to the orchestrator debug dir';
    }
    dom.autoApprovePlanBtn.setAttribute('aria-pressed', inst.autoApprovePlan ? 'true' : 'false');
    const canType = ['idle', 'turn', 'spawning'].includes(inst.status);
    const canSend = ['idle', 'turn'].includes(inst.status);
    // While the overage window is active the composer stays usable, but sending
    // QUEUES the message (delivered when the window resets). Key on the GLOBAL
    // signal (overageActive) as well as an armed session (autoResumeAt) so
    // opening OR starting any chat during the window immediately shows the paused
    // banner + "Queue" button — even before the first message is typed.
    composer.set({ canType, canSend,
      overagePaused: !!(inst.overageActive || inst.autoResumeAt),
      resumeAt: inst.autoResumeAt ?? inst.overageResetsAt ?? null });
    // Rewind/fork buttons are only safe between turns — the server refuses
    // a rewind during `turn` status anyway, but disabling them here keeps
    // the UX honest (no clickable button that just throws a 409).
    conversation.setUserActionsEnabled(inst.status === 'idle');
    dom.composerInput.placeholder = inst.status === 'turn'
      ? 'turn running — type to steer the running turn'
      : inst.status === 'spawning'
        ? 'instance is starting…'
        : inst.status === 'crashed' || inst.status === 'exited'
          ? 'instance is not running — click Resume'
          : 'Send a message — Enter to send, Shift+Enter for newline';
  }

  return { update };
}
