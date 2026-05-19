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
// Opus 4.7's default is 200k; the [1m] variant is the 1M-context build.
const CONTEXT_WINDOWS = {
  'claude-opus-4-7': 200_000,
  'claude-opus-4-7[1m]': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

export function contextWindowFor(model) {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  return CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
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
    if (ev.kind === 'turn_end' && ev.usage) {
      const u = ev.usage;
      this.lastUsage = u;
      this.cum.inputTokens   += u.input_tokens ?? 0;
      this.cum.outputTokens  += u.output_tokens ?? 0;
      this.cum.cacheRead     += u.cache_read_input_tokens ?? 0;
      this.cum.cacheCreation += u.cache_creation_input_tokens ?? 0;
      this.cum.cost          += ev.cost ?? 0;
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
