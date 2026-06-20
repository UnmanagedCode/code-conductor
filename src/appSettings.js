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
import { MODEL_FAMILIES } from './modelVersions.js';

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
//
// Read-time DATA migration (not request/route compat): a user who had the
// legacy boolean `autoStopOnOverage: true` and has never set the new enum key
// maps to 'stop' so they don't silently lose the behavior. The legacy key is
// removed on the next setOnOverageAction() write.
const VALID_ON_OVERAGE = ['none', 'stop', 'stop-resume'];

export function getOnOverageAction() {
  const s = loadSync();
  const v = s.models?.onOverage;
  if (v === 'stop' || v === 'stop-resume') return v;
  if (v === undefined && s.models?.autoStopOnOverage === true) return 'stop'; // migrate legacy ON
  return 'none';
}

export async function setOnOverageAction(action) {
  const val = VALID_ON_OVERAGE.includes(action) ? action : 'none';
  const cur = loadSync();
  const models = { ...(cur.models || {}), onOverage: val };
  delete models.autoStopOnOverage; // one-time cleanup of the legacy key
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

// Models group: per-family visibility toggle. When a family is false it is
// hidden from all spawn pickers. All families default to true (opt-out).
// Migrates the legacy scalar `fable5Enabled` key on first read.
//
// Derived from MODEL_FAMILIES so the family enum has a single source of truth;
// callers spread/index the result, so key order is irrelevant.
const ENABLED_FAMILIES_DEFAULTS = Object.fromEntries(MODEL_FAMILIES.map(f => [f.family, true]));

// Default spawn family used as the fallback wherever no valid family is set.
// Family-selection policy (MODEL_FAMILIES has no "default family" marker), so
// it's a single named constant rather than a derived value.
const DEFAULT_SPAWN_FAMILY = 'opus';

export function getEnabledFamilies() {
  const s = loadSync();
  if (s.models?.enabledFamilies !== undefined) {
    return { ...ENABLED_FAMILIES_DEFAULTS, ...s.models.enabledFamilies };
  }
  // Migration: honour legacy fable5Enabled: false
  if (s.models?.fable5Enabled === false) return { ...ENABLED_FAMILIES_DEFAULTS, fable: false };
  return { ...ENABLED_FAMILIES_DEFAULTS };
}

// Disable/enable one family. Guards against disabling the last enabled family.
// Auto-reassigns defaultFamily when the disabled family is the current default.
// Cleans up the legacy fable5Enabled key on write.
export async function setFamilyEnabled(family, enabled) {
  const cur = loadSync();
  const current = getEnabledFamilies();

  if (!enabled) {
    const remaining = MODEL_FAMILIES.filter(f => f.family !== family && current[f.family] !== false);
    if (remaining.length === 0) {
      throw Object.assign(new Error('cannot disable the last enabled family'), { statusCode: 400 });
    }
  }

  const nextEnabled = { ...current, [family]: !!enabled };

  let nextDefault = cur.models?.defaultFamily ?? DEFAULT_SPAWN_FAMILY;
  if (!enabled && nextDefault === family) {
    // Deliberate fallback-preference order (NOT the MODEL_FAMILIES catalog
    // order) — mirrored client-side in public/app.js defaultSpawnFamily().
    nextDefault = ['sonnet', 'haiku', 'opus', 'fable'].find(f => f !== family && nextEnabled[f] !== false) ?? 'sonnet';
  }

  const models = { ...(cur.models || {}), enabledFamilies: nextEnabled, defaultFamily: nextDefault };
  delete models.fable5Enabled; // remove legacy key
  await writeSettings({ ...cur, models });
  return { enabledFamilies: nextEnabled, defaultSpawnFamily: nextDefault };
}

// Models group: default spawn model family. Controls which model card is
// pre-selected when the spawn dialog opens. Defaults to 'opus' when unset.
// Membership is derived from MODEL_FAMILIES (used only via .includes(), so
// catalog order is irrelevant).
const VALID_SPAWN_FAMILIES = MODEL_FAMILIES.map(f => f.family);

export function getDefaultSpawnFamily() {
  const s = loadSync();
  const v = s.models?.defaultFamily;
  return VALID_SPAWN_FAMILIES.includes(v) ? v : DEFAULT_SPAWN_FAMILY;
}

export async function setDefaultSpawnFamily(family) {
  const val = VALID_SPAWN_FAMILIES.includes(family) ? family : DEFAULT_SPAWN_FAMILY;
  const cur = loadSync();
  const next = { ...cur, models: { ...(cur.models || {}), defaultFamily: val } };
  await writeSettings(next);
  return val;
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

// Models group: optional usage-threshold overage trip (window-agnostic). When
// enabled, the overage auto-stop also fires once any rate-limit window's
// `utilization` crosses this percentage — before paid overage credits are
// reached. Independent of (and additive to) the always-on `isUsingOverage`
// hard-flag trip. Value is an integer percent, clamped+snapped to [50,99]
// Off by default — strictly opt-in. Follows the conductorCompactWindow
// opt-in precedent above.
const OVERAGE_PCT_MIN     = 50;
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
