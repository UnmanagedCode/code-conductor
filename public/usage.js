// Per-instance context-usage tracker. Consumes the same UI event stream
// the conversation + task panel see, surfacing:
//   - currentContextSize(): the most recent turn's prompt size
//     (input + cache_read + cache_creation) — i.e. "how full is the
//     context window right now".
//   - cum: cumulative session totals across every turn_end observed.
//
// Designed to mirror TaskTracker so app.js can drive it with the same
// reset() + apply(ev) shape from the snapshot/event listeners.

// Hardcoded lookup — there's no API surface that reports each model's
// context-window size, and the CLI doesn't carry it in system/init.
//
// One fixed window per family (mirrors canonicalizeModel in
// src/modelVersions.js): Opus → 1M, Sonnet → 1M, Haiku → 200k. Keyed on
// the bare id; `contextWindowFor` strips any `[200k]`/`[1m]` suffix first,
// so it's correct regardless of whether the CLI echoes the suffix in
// system/init.
const CONTEXT_WINDOWS = {
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

export function contextWindowFor(model) {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const bare = model.replace(/\[(200k|1m)\]$/, '');
  return CONTEXT_WINDOWS[bare] ?? DEFAULT_CONTEXT_WINDOW;
}

export class UsageTracker {
  constructor() { this.reset(); }

  reset() {
    this.model = null;        // from system/init.data.model (authoritative)
    this.lastUsage = null;    // last observed turn_end.usage object
    this.cum = {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      cost: 0,
      turns: 0,
      durationMs: 0,
    };
  }

  apply(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'system' && ev.subtype === 'init') {
      const m = ev.data?.model;
      if (m) this.model = m;
      return;
    }
    // message_start is the AUTHORITATIVE source for "current context
    // size" — it fires once per agent-loop LLM call and its `usage`
    // carries that single call's prompt size (input + cache_read +
    // cache_creation). Each step within a long multi-tool turn sends
    // its own, so currentContextSize tracks the growing prompt live.
    if (ev.kind === 'message_start' && ev.usage) {
      this.lastUsage = ev.usage;
      // TEMP DIAGNOSTIC — logs every message_start so we can spot which
      // event produces the >100% spike at turn end. Remove once root-caused.
      const size = (ev.usage.input_tokens ?? 0)
                 + (ev.usage.cache_read_input_tokens ?? 0)
                 + (ev.usage.cache_creation_input_tokens ?? 0);
      console.log('[usage] message_start',
        'size=' + size,
        'in=' + (ev.usage.input_tokens ?? 0),
        'cache_r=' + (ev.usage.cache_read_input_tokens ?? 0),
        'cache_c=' + (ev.usage.cache_creation_input_tokens ?? 0),
        'out=' + (ev.usage.output_tokens ?? 0),
        'msgId=' + ev.msgId,
        'parent=' + (ev.parentToolUseId ?? 'null'));
      return;
    }
    // turn_end's `usage`, by contrast, is the per-turn SUM across every
    // agent-loop LLM call in that turn. A turn with 100 tool calls each
    // reading 74k from cache lands here as cache_read=7.4M — that's
    // total tokens billed for the turn, not the current context size.
    // So we MUST NOT update lastUsage from turn_end (that's the bug
    // that produced ctx 743% on a 1M window). turn_end only contributes
    // to cum.*, which is genuinely cumulative work over the session.
    if (ev.kind === 'turn_end' && ev.usage) {
      const u = ev.usage;
      this.cum.inputTokens   += u.input_tokens ?? 0;
      this.cum.outputTokens  += u.output_tokens ?? 0;
      this.cum.cacheRead     += u.cache_read_input_tokens ?? 0;
      this.cum.cacheCreation += u.cache_creation_input_tokens ?? 0;
      // costDelta is the actual cost of this turn; ev.cost is the cumulative
      // session total emitted by the CLI. Use the delta to avoid double-counting.
      this.cum.cost          += ev.costDelta ?? ev.cost ?? 0;
      this.cum.durationMs    += ev.durationMs ?? 0;
      this.cum.turns         += 1;
    }
  }

  // Most recent turn's prompt size, in tokens. Null when no turn has
  // landed yet (just-spawned instance with no usage data).
  currentContextSize() {
    const u = this.lastUsage;
    if (!u) return null;
    return (u.input_tokens ?? 0)
         + (u.cache_read_input_tokens ?? 0)
         + (u.cache_creation_input_tokens ?? 0);
  }

  // Fraction in [0, 1+]. `modelOverride` lets the caller pass the
  // instance's spawn-time model when system/init hasn't arrived yet.
  currentFillPct(modelOverride) {
    const used = this.currentContextSize();
    if (used == null) return null;
    return used / contextWindowFor(modelOverride || this.model);
  }

  // Effective model used by currentFillPct(), surfaced so the popover
  // can label the limit accurately.
  effectiveModel(modelOverride) {
    return modelOverride || this.model || null;
  }
}

// Pure formatters — exported for both the chip body and the popover.
// Kept here (not in app.js) so the test file can assert their output
// without spinning up happy-dom.

export function formatTokens(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return String(n);
}

export function formatPct(frac) {
  if (frac == null || !Number.isFinite(frac)) return '—';
  const pct = frac * 100;
  if (pct < 1 && pct > 0) return '<1%';
  return Math.round(pct) + '%';
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fillClass(frac) {
  if (frac == null) return 'ih-usage-empty';
  if (frac < 0.5) return 'ih-usage-low';
  if (frac < 0.8) return 'ih-usage-mid';
  return 'ih-usage-high';
}

// ── Rate-limit tracker ──────────────────────────────────────────────────
// Per-instance tracker for the latest rate_limit_event payload. Mirrors
// UsageTracker's reset() + apply(ev) shape so app.js drives it identically.

export class RateLimitTracker {
  constructor() { this.reset(); }

  reset() {
    this.info = null; // latest rate_limit_info object (null until first event)
  }

  apply(ev) {
    if (ev?.kind !== 'system' || ev.subtype !== 'rate_limit_event') return;
    const raw = ev.data ?? {};
    // Accept both nested (rate_limit_info) and flat shapes defensively.
    this.info = raw.rate_limit_info ?? (Object.keys(raw).length ? raw : null);
  }
}

// Friendly labels for the rateLimitType values the CLI emits.
const RATE_LIMIT_TYPE_LABELS = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
};

// Format the resetsAt Unix timestamp as a local time string, e.g. "resets 6:40pm".
export function formatResetTime(unixSecs) {
  if (!unixSecs || !Number.isFinite(unixSecs)) return null;
  const d = new Date(unixSecs * 1000);
  return 'resets ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Build the rate-limit chip element from a rate_limit_info object.
// Returns null when info is falsy (slot should stay hidden).
// Reuses fillClass() and ih-usage-* colour CSS from the context chip.
export function renderRateLimitChip(info) {
  if (!info) return null;

  const typeLabel = RATE_LIMIT_TYPE_LABELS[info.rateLimitType] ?? info.rateLimitType ?? '?';
  const util = typeof info.utilization === 'number' ? info.utilization : null;
  // utilization is only present once a bucket crosses a warning threshold;
  // when absent use null so fillClass returns the neutral ih-usage-empty class.
  const frac = util != null ? util / 100 : null;
  const resetStr = formatResetTime(info.resetsAt);
  const isOverage = info.isUsingOverage === true;

  const el = document.createElement('span');
  el.className = `ih-chip ih-ratelimit ${fillClass(frac)}`;
  el.title = [
    `Rate limit bucket: ${typeLabel}`,
    util != null ? `Utilization: ${util}%` : null,
    resetStr,
    isOverage ? 'OVERAGE active' : null,
  ].filter(Boolean).join(' · ');

  let text = `rl ${typeLabel}`;
  if (util != null) text += ` · ${Math.round(util)}%`;
  el.textContent = text;

  if (isOverage) {
    const badge = document.createElement('span');
    badge.className = 'rl-overage-badge';
    badge.textContent = 'OVERAGE';
    el.appendChild(badge);
  }

  return el;
}
