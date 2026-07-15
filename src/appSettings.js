// Persistent app-level settings, stored at `<orchStoreRoot()>/settings.json`
// (the workspace-wide central store). Currently holds the active transcribe
// model; structured as a namespaced object so future settings groups slot in
// without a schema migration.
//
// Reads are served from an in-memory cache (lazily seeded from disk with a
// synchronous read — the file is tiny and the read paths, e.g. resolving the
// whisper model in transcribe.js, are not hot). Writes are atomic
// (tmp → rename) and refresh the cache.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot, writeFileAtomic } from './projects.js';
import { CAPABILITY_TIERS, DEFAULT_TIER_BACKEND, isKnownTier, isKnownFamily, OLLAMA_ID_PREFIX, isOllamaBackendId } from './modelVersions.js';

function settingsPath() {
  return path.join(orchStoreRoot(), 'settings.json');
}

let cache = null;
let cachedFor = null; // settingsPath() the cache was seeded from — guards test env swaps

function loadSync() {
  const p = settingsPath();
  if (cache !== null && cachedFor === p) return cache;
  try {
    cache = JSON.parse(readFileSync(p, 'utf8')) || {};
  } catch {
    cache = {};
  }
  cachedFor = p;
  return cache;
}

export function readSettings() {
  return loadSync();
}

async function writeSettings(next) {
  const p = settingsPath();
  await writeFileAtomic(p, JSON.stringify(next, null, 2));
  cache = next;
  cachedFor = p;
}

export function getTranscribeModel() {
  const s = loadSync();
  return s.transcribe?.model ?? null;
}

export async function setTranscribeModel(name) {
  const cur = loadSync();
  const next = { ...cur, transcribe: { ...(cur.transcribe || {}), model: name } };
  await writeSettings(next);
  return name;
}

// Models group: the active concrete version id per Claude family
// (`models.sonnet`, `models.opus`, `models.haiku`). Returns null when unset
// so callers fall back to the catalog default (see modelVersions.js).
export function getModelVersion(family) {
  const s = loadSync();
  return s.models?.[family] ?? null;
}

export async function setModelVersion(family, id) {
  const cur = loadSync();
  const next = { ...cur, models: { ...(cur.models || {}), [family]: id } };
  await writeSettings(next);
  return id;
}

// TTS group: the `tts` namespace holds { enabled, voice, rate }.
// `enabled` gates auto-speak of finalized assistant messages; `voice` is the
// active Piper voice name (null → built-in default, see ttsModels.js); `rate`
// is the playback speed multiplier (1.0 = natural). Each setter spreads the
// existing namespace so it never clobbers `transcribe`/`models`.
const TTS_RATE_MIN = 0.5;
const TTS_RATE_MAX = 2.0;

export function getTtsEnabled() {
  const s = loadSync();
  return s.tts?.enabled ?? false;
}

export async function setTtsEnabled(enabled) {
  const cur = loadSync();
  const next = { ...cur, tts: { ...(cur.tts || {}), enabled: !!enabled } };
  await writeSettings(next);
  return !!enabled;
}

export function getTtsVoice() {
  const s = loadSync();
  return s.tts?.voice ?? null;
}

export async function setTtsVoice(name) {
  const cur = loadSync();
  const next = { ...cur, tts: { ...(cur.tts || {}), voice: name } };
  await writeSettings(next);
  return name;
}

export function getTtsRate() {
  const s = loadSync();
  return s.tts?.rate ?? 1.0;
}

export async function setTtsRate(rate) {
  const n = Number(rate);
  const clamped = Number.isFinite(n) ? Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, n)) : 1.0;
  const cur = loadSync();
  const next = { ...cur, tts: { ...(cur.tts || {}), rate: clamped } };
  await writeSettings(next);
  return clamped;
}

// Models group: action on overage (overtime). Enum 'none' | 'stop' |
// 'stop-resume'. When the server receives a rate_limit_event with
// isUsingOverage === true it soft-interrupts the running turn for both 'stop'
// and 'stop-resume'; 'stop-resume' additionally schedules an in-memory timer
// that resumes the (still-alive) session at the rate-limit reset time. Off
// ('none') by default — strictly opt-in.
const VALID_ON_OVERAGE = ['none', 'stop', 'stop-resume'];

export function getOnOverageAction() {
  const s = loadSync();
  const v = s.models?.onOverage;
  return v === 'stop' || v === 'stop-resume' ? v : 'none';
}

export async function setOnOverageAction(action) {
  const val = VALID_ON_OVERAGE.includes(action) ? action : 'none';
  const cur = loadSync();
  const models = { ...(cur.models || {}), onOverage: val };
  await writeSettings({ ...cur, models });
  return val;
}

// Models group: Sonnet context-window preference. '1m' (default) keeps the
// CLI-native `[1m]` suffix so Sonnet spawns at 1M; '200k' uses the bare id
// so Sonnet spawns at its CLI-native 200k default. Defaults to '1m' to
// preserve pre-existing behaviour — change via Settings → Models.
export function getSonnetContextWindow() {
  const s = loadSync();
  return s.models?.sonnetContextWindow === '200k' ? '200k' : '1m';
}

export async function setSonnetContextWindow(window) {
  const val = window === '200k' ? '200k' : '1m';
  const cur = loadSync();
  const next = { ...cur, models: { ...(cur.models || {}), sonnetContextWindow: val } };
  await writeSettings(next);
  return val;
}

// Models group: per-tier visibility toggle. When a tier is false it is
// hidden from all spawn pickers. All tiers default to true (opt-out).
//
// Derived from CAPABILITY_TIERS so the tier enum has a single source of
// truth; callers spread/index the result, so key order is irrelevant.
const ENABLED_TIERS_DEFAULTS = Object.fromEntries(CAPABILITY_TIERS.map(t => [t.tier, true]));

// Default spawn tier used as the fallback wherever no valid tier is set.
// Chosen to match today's fresh-install default family ('opus'), which sits
// under the 'powerful' tier in DEFAULT_TIER_BACKEND.
const DEFAULT_SPAWN_TIER = 'powerful';

export function getEnabledTiers() {
  const s = loadSync();
  if (s.models?.enabledTiers !== undefined) {
    return { ...ENABLED_TIERS_DEFAULTS, ...s.models.enabledTiers };
  }
  return { ...ENABLED_TIERS_DEFAULTS };
}

// Disable/enable one tier. Guards against disabling the last enabled tier.
// Auto-reassigns defaultTier when the disabled tier is the current default.
export async function setTierEnabled(tier, enabled) {
  const cur = loadSync();
  const current = getEnabledTiers();

  if (!enabled) {
    const remaining = CAPABILITY_TIERS.filter(t => t.tier !== tier && current[t.tier] !== false);
    if (remaining.length === 0) {
      throw Object.assign(new Error('cannot disable the last enabled tier'), { statusCode: 400 });
    }
  }

  const nextEnabled = { ...current, [tier]: !!enabled };

  let nextDefault = cur.models?.defaultTier ?? DEFAULT_SPAWN_TIER;
  if (!enabled && nextDefault === tier) {
    // Deliberate fallback-preference order (NOT the CAPABILITY_TIERS catalog
    // order) — mirrored client-side in public/spawnDialog.js defaultSpawnTier().
    nextDefault = ['balanced', 'fast', 'powerful', 'frontier'].find(t => t !== tier && nextEnabled[t] !== false) ?? 'balanced';
  }

  const models = { ...(cur.models || {}), enabledTiers: nextEnabled, defaultTier: nextDefault };
  await writeSettings({ ...cur, models });
  return { enabledTiers: nextEnabled, defaultSpawnTier: nextDefault };
}

// Models group: default spawn tier. Controls which model card is
// pre-selected when the spawn dialog opens. Defaults to 'powerful' when unset.
// Membership is derived from CAPABILITY_TIERS (used only via .includes(), so
// catalog order is irrelevant).
const VALID_SPAWN_TIERS = CAPABILITY_TIERS.map(t => t.tier);

export function getDefaultSpawnTier() {
  const s = loadSync();
  const v = s.models?.defaultTier;
  return VALID_SPAWN_TIERS.includes(v) ? v : DEFAULT_SPAWN_TIER;
}

export async function setDefaultSpawnTier(tier) {
  const val = VALID_SPAWN_TIERS.includes(tier) ? tier : DEFAULT_SPAWN_TIER;
  const cur = loadSync();
  const next = { ...cur, models: { ...(cur.models || {}), defaultTier: val } };
  await writeSettings(next);
  return val;
}

// Models group: custom (Ollama-backed) backends. Persisted as
// `models.customBackends: [{ id, label, model, host }]`, where `id` is
// namespace-prefixed (`ollama:<slug>`) so it never collides with a Claude
// family key. `model` is the Ollama tag; `host` is optional ('' ⇒ default
// localhost:11434). These merge into the backend catalog so a tier can bind to
// one just like a Claude family.
export function getCustomBackends() {
  const s = loadSync();
  const list = s.models?.customBackends;
  return Array.isArray(list) ? list.filter(b => b && typeof b.id === 'string') : [];
}

export function getCustomBackend(id) {
  return getCustomBackends().find(b => b.id === id) ?? null;
}

export function isKnownCustomBackend(id) {
  return isOllamaBackendId(id) && getCustomBackends().some(b => b.id === id);
}

// A backend key is bindable if it's a known Claude family OR a known custom
// backend. Used by the tier getter/setter and the Settings route validation.
export function isKnownBackend(key) {
  return isKnownFamily(key) || isKnownCustomBackend(key);
}

function slugifyLabel(label) {
  const base = String(label || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'model';
}

export async function addCustomBackend({ label, model, host } = {}) {
  const cleanLabel = String(label || '').trim();
  const cleanModel = String(model || '').trim();
  const cleanHost = String(host || '').trim();
  if (!cleanLabel || !cleanModel) {
    throw Object.assign(new Error('label and model (ollama tag) are required'), { statusCode: 400 });
  }
  const cur = loadSync();
  const existing = getCustomBackends();
  // Generate a collision-free prefixed id from the label slug.
  const slug = slugifyLabel(cleanLabel);
  let id = `${OLLAMA_ID_PREFIX}${slug}`;
  let n = 2;
  while (existing.some(b => b.id === id)) { id = `${OLLAMA_ID_PREFIX}${slug}-${n++}`; }
  const rec = { id, label: cleanLabel, model: cleanModel, host: cleanHost };
  const nextList = [...existing, rec];
  const next = { ...cur, models: { ...(cur.models || {}), customBackends: nextList } };
  await writeSettings(next);
  return rec;
}

// Remove a custom backend. Any tier still bound to it falls back gracefully:
// getTierBackend's isKnownBackend guard reverts the (now-unknown) binding to
// the tier's default Claude family on the next read.
export async function removeCustomBackend(id) {
  const cur = loadSync();
  const existing = getCustomBackends();
  const nextList = existing.filter(b => b.id !== id);
  if (nextList.length === existing.length) return false;
  const next = { ...cur, models: { ...(cur.models || {}), customBackends: nextList } };
  await writeSettings(next);
  return true;
}

// Models group: tier → backend binding. Each tier resolves to a MODEL_FAMILIES
// entry OR a custom-backend id; rebinding a tier never affects a legacy caller
// that passes a family name directly (see isKnownFamily branch in
// src/mcp/handlers.js spawnInstance), only tier-based resolution.
//
// IMPORTANT: the fallback guard uses isKnownBackend (family OR custom), NOT
// isKnownFamily — otherwise a valid custom-backend binding would be silently
// reverted to the Claude default on every read.
export function getTierBackend(tier) {
  const s = loadSync();
  const stored = s.models?.tierBackend?.[tier];
  return isKnownBackend(stored) ? stored : DEFAULT_TIER_BACKEND[tier];
}

export async function setTierBackend(tier, backend) {
  if (!isKnownTier(tier) || !isKnownBackend(backend)) {
    throw Object.assign(new Error('unknown tier or backend'), { statusCode: 400 });
  }
  const cur = loadSync();
  const nextTierBackend = { ...(cur.models?.tierBackend || {}), [tier]: backend };
  const next = { ...cur, models: { ...(cur.models || {}), tierBackend: nextTierBackend } };
  await writeSettings(next);
  return nextTierBackend;
}

// Models group: conductor compact window override. When enabled, sets
// CLAUDE_CODE_AUTO_COMPACT_WINDOW on the child process env for conductor
// (MCP-spawned) sessions so Claude compacts as if the window were this size.
// Value is stored in k-tokens (e.g. 200 = 200k); the env var receives raw
// tokens (value * 1000). Seeded from the orchestrator's own env if set.
// Off by default — strictly opt-in.
const COMPACT_K_MIN  = 20;
const COMPACT_K_MAX  = 1000;
const COMPACT_K_STEP = 10;
const COMPACT_K_DEFAULT = 200;

function snapCompactK(k) {
  const snapped = Math.round(k / COMPACT_K_STEP) * COMPACT_K_STEP;
  return Math.max(COMPACT_K_MIN, Math.min(COMPACT_K_MAX, snapped));
}

export function getConductorCompactWindow() {
  const s = loadSync();
  const envRaw    = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const envTokens = envRaw ? parseInt(envRaw, 10) : null;
  const envK      = (Number.isFinite(envTokens) && envTokens > 0)
    ? snapCompactK(Math.round(envTokens / 1000))
    : null;
  return {
    enabled: s.models?.conductorCompactWindowEnabled ?? (envK !== null),
    value:   s.models?.conductorCompactWindowK       ?? envK ?? COMPACT_K_DEFAULT,
  };
}

export async function setConductorCompactWindow({ enabled, value }) {
  const n = Number(value);
  const snapped = snapCompactK(Number.isFinite(n) ? n : COMPACT_K_DEFAULT);
  const cur  = loadSync();
  const next = {
    ...cur,
    models: {
      ...(cur.models || {}),
      conductorCompactWindowEnabled: !!enabled,
      conductorCompactWindowK:       snapped,
    },
  };
  await writeSettings(next);
  return { enabled: !!enabled, value: snapped };
}

// Models group: optional UTILIZATION-based overage stop threshold — the single
// unified knob shared by BOTH trigger sources. When enabled, the overage auto-stop
// fires once a rate-limit window's live `utilization` crosses this percentage —
// before paid overage credits are reached. It is read by the stream-event path
// (instances.js `_isOverageTrip`, where it only fires near Anthropic's own ~90%
// reporting) AND by the server-side usage poller (usageOverageMonitor.js), which is
// what makes LOW thresholds actionable. Utilization-based, NOT tied to Anthropic's
// paid-overage flag — that hard `isUsingOverage` trip is always-on and independent.
// Value is an integer percent, clamped to [10,99] (floor lowered from 50 so
// conserve-early targets like 25% are settable). Off by default — strictly opt-in.
const OVERAGE_PCT_MIN     = 10;
const OVERAGE_PCT_MAX     = 99;
const OVERAGE_PCT_DEFAULT = 85;

function snapOveragePct(p) {
  return Math.max(OVERAGE_PCT_MIN, Math.min(OVERAGE_PCT_MAX, Math.round(p)));
}

export function getOverageThreshold() {
  const s = loadSync();
  return {
    enabled: s.models?.overageThresholdEnabled ?? false,
    value:   s.models?.overageThresholdPct     ?? OVERAGE_PCT_DEFAULT,
  };
}

// Single source of truth for "is the account still over the overage bar?", given
// an account-usage payload (src/accountUsage.js shape: five_hour.utilization is a
// 0–100 PERCENT). Used by BOTH the server-side poll trip (usageOverageMonitor) and
// the usage-verified auto-resume (overageResume) so the trip and the resume never
// disagree. Returns:
//   true  — still over: the five-hour window is fully consumed (utilization >= 100,
//           the usage-payload proxy for the stream-only `isUsingOverage` hard flag,
//           checked even when the optional threshold is off), OR the configured
//           threshold is enabled and its percent is still crossed.
//   false — clear: window has reset / dropped below the bar.
//   null  — can't tell: payload missing/malformed (caller treats like a failed fetch).
export function usageOverThreshold(usage) {
  const win = usage?.five_hour;
  if (!win || typeof win.utilization !== 'number') return null;
  if (win.utilization >= 100) return true; // hard-overage proxy (window not reset)
  const t = getOverageThreshold();
  if (t.enabled && win.utilization >= t.value) return true;
  return false;
}

export async function setOverageThreshold({ enabled, value }) {
  const n = Number(value);
  const snapped = snapOveragePct(Number.isFinite(n) ? n : OVERAGE_PCT_DEFAULT);
  const cur  = loadSync();
  const next = {
    ...cur,
    models: {
      ...(cur.models || {}),
      overageThresholdEnabled: !!enabled,
      overageThresholdPct:     snapped,
    },
  };
  await writeSettings(next);
  return { enabled: !!enabled, value: snapped };
}
