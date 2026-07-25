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
import { CAPABILITY_TIERS, DEFAULT_TIER_BACKEND, isKnownTier, isKnownClaudeModel,
  ROLES, DEFAULT_ROLE_BINDING, isKnownRole, isKnownFamily, sonnetWindowSelectable,
  SLUG_RE, SLUG_MAX } from './modelVersions.js';
import { OLLAMA_CLOUD_MODELS, isKnownOllamaCloudModel } from './ollamaCloudModels.js';

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

// Spawn group: debugByDefault gates whether a newly spawned instance mirrors
// raw CLI traffic to the debug dir when the spawn call doesn't name `debug`
// explicitly (see InstanceManager._doCreate). Off by default — strictly opt-in.
export function getDebugByDefault() {
  const s = loadSync();
  return s.spawn?.debugByDefault ?? false;
}

export async function setDebugByDefault(enabled) {
  const cur = loadSync();
  const next = { ...cur, spawn: { ...(cur.spawn || {}), debugByDefault: !!enabled } };
  await writeSettings(next);
  return !!enabled;
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

// Models group: custom (Ollama-served) models. Persisted as
// `models.customBackends: [{ label, model }]`, where `model` is the Ollama tag
// (the identity — no separate id). Localhost-only; no host field. This is the
// catalog the Settings Ollama model selector lists.
export function getCustomBackends() {
  const s = loadSync();
  const list = s.models?.customBackends;
  return Array.isArray(list) ? list.filter(b => b && typeof b.model === 'string') : [];
}

// A tag is a bindable Ollama model if the user has added it, or if it's one
// of the curated cloud presets (bindable with no prior "Add" step).
export function isKnownOllamaModel(tag) {
  return typeof tag === 'string' && !!tag &&
    (getCustomBackends().some(b => b.model === tag) || isKnownOllamaCloudModel(tag));
}

// Native context window (raw tokens) for an Ollama tag, or null when unknown.
// Custom backends win over the curated catalog (a user override of a preset).
// The server always holds the full tag in Instance.model, so exact-tag match
// suffices here (the client resolver additionally tolerates the bare base name
// the CLI reports — see ollamaContextWindowFor in public/models.js).
export function getOllamaContextWindow(tag) {
  if (typeof tag !== 'string' || !tag) return null;
  const custom = getCustomBackends().find(b => b.model === tag);
  if (custom && Number.isFinite(custom.contextWindow)) return custom.contextWindow;
  const preset = OLLAMA_CLOUD_MODELS.find(m => m.model === tag);
  if (preset && Number.isFinite(preset.contextWindow)) return preset.contextWindow;
  return null;
}

// `contextWindow` (optional): native window in raw tokens. When a positive
// number, it's stored (rounded) and used for the header ctx bar +
// CLAUDE_CODE_AUTO_COMPACT_WINDOW at spawn. Blank/invalid → the key is omitted
// and the model falls back to the 200k display default with no explicit compact
// window at spawn.
export async function addCustomBackend({ label, model, contextWindow } = {}) {
  const cleanLabel = String(label || '').trim();
  const cleanModel = String(model || '').trim();
  if (!cleanLabel || !cleanModel) {
    throw Object.assign(new Error('label and model (ollama tag) are required'), { statusCode: 400 });
  }
  const cw = Number(contextWindow);
  const entry = { label: cleanLabel, model: cleanModel };
  if (Number.isFinite(cw) && cw > 0) entry.contextWindow = Math.round(cw);
  const cur = loadSync();
  const existing = getCustomBackends();
  // The tag is the identity — adding an existing tag just updates its label.
  const nextList = existing.filter(b => b.model !== cleanModel).concat([entry]);
  const next = { ...cur, models: { ...(cur.models || {}), customBackends: nextList } };
  await writeSettings(next);
  return entry;
}

// Remove a custom model by tag. Any tier still bound to it falls back
// gracefully: getTierBackend's validation reverts the now-unknown binding to
// the tier's default Claude backend on the next read.
export async function removeCustomBackend(tag) {
  const cur = loadSync();
  const existing = getCustomBackends();
  const nextList = existing.filter(b => b.model !== tag);
  if (nextList.length === existing.length) return false;
  const next = { ...cur, models: { ...(cur.models || {}), customBackends: nextList } };
  await writeSettings(next);
  return true;
}

// True if a {kind, model} binding names a real, currently-available backend.
function isValidBinding(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.kind === 'claude') return isKnownClaudeModel(b.model);
  if (b.kind === 'ollama') return isKnownOllamaModel(b.model);
  return false;
}

// Reconstruct the persisted shape of a concrete {kind, model} binding, keeping
// only the fields that matter. A Claude binding on a user-selectable-window
// Sonnet (4.x) carries its chosen `window` ('1m'|'200k'); every other binding
// (Ollama, Opus/Haiku/Fable, fixed-window Sonnet 5) stores no window — those
// families ignore it, so persisting one would be misleading noise.
function persistBinding(b) {
  const out = { kind: b.kind, model: b.model };
  if (b.kind === 'claude' && sonnetWindowSelectable(b.model) && (b.window === '1m' || b.window === '200k')) {
    out.window = b.window;
  }
  return out;
}

// Models group: tier → {kind, model} binding. `kind` is 'claude' (model = a
// MODEL_FAMILIES version id) or 'ollama' (model = an Ollama tag).
//
// IMPORTANT: a valid binding is returned verbatim (no silent revert); only an
// invalid/dead binding (unknown version, or a since-removed Ollama tag) falls
// back to the tier's default Claude backend.
export function getTierBackend(tier) {
  const s = loadSync();
  const stored = s.models?.tierBackend?.[tier];
  return isValidBinding(stored) ? stored : DEFAULT_TIER_BACKEND[tier];
}

export async function setTierBackend(tier, backend) {
  if (!isKnownTier(tier) || !isValidBinding(backend)) {
    throw Object.assign(new Error('tierBackend must be {kind, model} naming a known backend'), { statusCode: 400 });
  }
  const cur = loadSync();
  const nextTierBackend = { ...(cur.models?.tierBackend || {}), [tier]: persistBinding(backend) };
  const next = { ...cur, models: { ...(cur.models || {}), tierBackend: nextTierBackend } };
  await writeSettings(next);
  return nextTierBackend;
}

// Roles group: role → binding. A binding is EITHER a tier binding
// ({kind:'tier', tier}) or a custom {kind, model} backend (same shape a tier
// binds to). A tier binding validates via isKnownTier; a custom binding via
// isValidBinding.
function isValidRoleBinding(b) {
  if (b && typeof b === 'object' && b.kind === 'tier') return isKnownTier(b.tier);
  return isValidBinding(b);
}

// A role's fallback binding when nothing valid is stored. Built-in roles use
// their catalog default; a custom role (no catalog default) falls back to the
// current default spawn tier so it always resolves to a live backend.
function defaultRoleBinding(role) {
  return DEFAULT_ROLE_BINDING[role] ?? { kind: 'tier', tier: getDefaultSpawnTier() };
}

// True if a role name is a built-in (modelVersions ROLES) or a user custom role
// — i.e. one whose binding lives in `models.roleBackend` and is user-editable.
// Plugin roles (namespaced <plugin-id>/<slug>, live-derived) are NOT settable.
function isSettableRole(role) {
  return isKnownRole(role) || getCustomRoles().some(r => r.role === role);
}

// Stored role binding for a built-in or custom role (revert dead/invalid binding
// to the role default on read, like getTierBackend). A tier binding whose tier
// vanished, or a custom binding whose backend was removed, falls back to
// defaultRoleBinding(role). NOT for plugin roles — resolveRoleBackend handles
// those from the live provider binding.
export function getRoleBinding(role) {
  const s = loadSync();
  const stored = s.models?.roleBackend?.[role];
  return isValidRoleBinding(stored) ? stored : defaultRoleBinding(role);
}

export async function setRoleBinding(role, binding) {
  if (!isSettableRole(role) || !isValidRoleBinding(binding)) {
    throw Object.assign(new Error('roleBackend must name a built-in or custom role and be a known tier binding {kind:"tier",tier} or a {kind,model} backend'), { statusCode: 400 });
  }
  const stored = binding.kind === 'tier'
    ? { kind: 'tier', tier: binding.tier }
    : persistBinding(binding);
  const cur = loadSync();
  const nextRoleBackend = { ...(cur.models?.roleBackend || {}), [role]: stored };
  const next = { ...cur, models: { ...(cur.models || {}), roleBackend: nextRoleBackend } };
  await writeSettings(next);
  return nextRoleBackend;
}

// Resolve a role to a concrete {kind, model}. A tier binding delegates to
// getTierBackend (so a role→tier→dead-custom chain still reverts correctly); a
// custom binding is returned directly. Plugin roles resolve from their live
// manifest binding (never persisted), so they vanish when the plugin is disabled.
export function resolveRoleBackend(role) {
  const pluginRole = getPluginRoles().find(r => r.role === role);
  if (pluginRole) {
    const b = pluginRole.binding;
    if (b.kind === 'tier') return getTierBackend(b.tier);
    // A plugin claude binding is validated at manifest load, but the model
    // catalog can move on (a Claude version retired) between that load and this
    // resolve — never spawn a dead id. Mirror the custom-role fallback: revert to
    // the default spawn tier's backend. (Ollama is never a plugin binding kind.)
    if (b.kind === 'claude' && !isKnownClaudeModel(b.model)) {
      return getTierBackend(getDefaultSpawnTier());
    }
    return persistBinding(b);
  }
  const b = getRoleBinding(role);
  return b.kind === 'tier' ? getTierBackend(b.tier) : persistBinding(b);
}

// ── Custom + plugin roles ────────────────────────────────────────────────
// Plugin-owned roles are LIVE-DERIVED from enabled plugins (never persisted),
// mirroring plugin conventions: the provider is injected by server.js
// (`setPluginRolesProvider(() => pluginHost.roles())`) so this low-level store
// never imports the plugin registry. Each entry: {role:'<plugin-id>/<slug>',
// label, binding:{kind:'tier',tier}|{kind,model}, plugin:id}. Default [] keeps
// tests / headless runs (no plugin host) working, and disabling a plugin drops
// its roles automatically (the provider derives from enabled plugins).
let pluginRolesProvider = () => [];
export function setPluginRolesProvider(fn) {
  pluginRolesProvider = typeof fn === 'function' ? fn : (() => []);
}
export function getPluginRoles() {
  try {
    const list = pluginRolesProvider();
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// User custom roles: persisted as `models.customRoles: [{role, label}]` —
// identity + label only. The binding lives in `models.roleBackend[role]` exactly
// like a built-in role, so binding edits reuse setRoleBinding/getRoleBinding
// unchanged. A name must be a fresh slug (shared SLUG_RE/SLUG_MAX rule),
// disjoint from tiers / built-in roles / family aliases; '/' is reserved for
// plugin namespacing (the regex forbids it).

export function getCustomRoles() {
  const s = loadSync();
  const list = s.models?.customRoles;
  return Array.isArray(list) ? list.filter(r => r && typeof r.role === 'string' && typeof r.label === 'string') : [];
}

// The full live role catalog: built-in + user custom + plugin-owned. Each entry
// is {role, label, builtin?, plugin?}. Single source for the Settings payload
// and the resolution guard (isResolvableRole).
export function getAllRoles() {
  return [
    ...ROLES.map(r => ({ role: r.role, label: r.label, builtin: true })),
    ...getCustomRoles().map(r => ({ role: r.role, label: r.label })),
    ...getPluginRoles().map(r => ({ role: r.role, label: r.label, plugin: r.plugin })),
  ];
}

// True if a role name resolves to a backend today (built-in, custom, or a
// currently-enabled plugin's role). Used by spawnInstance in place of the static
// isKnownRole so custom/plugin roles are spawnable everywhere built-ins are.
export function isResolvableRole(role) {
  if (typeof role !== 'string' || !role) return false;
  if (isKnownRole(role)) return true;
  if (getCustomRoles().some(r => r.role === role)) return true;
  return getPluginRoles().some(r => r.role === role);
}

export async function addCustomRole({ role, label, binding } = {}) {
  const slug = String(role || '').trim();
  const name = String(label || '').trim();
  if (!SLUG_RE.test(slug) || slug.length > SLUG_MAX) {
    throw Object.assign(new Error('role must match ^[a-z][a-z0-9-]*$ (max 40 chars)'), { statusCode: 400 });
  }
  if (!name) throw Object.assign(new Error('label is required'), { statusCode: 400 });
  if (isKnownTier(slug) || isKnownRole(slug) || isKnownFamily(slug)) {
    throw Object.assign(new Error(`name '${slug}' collides with a built-in tier, role, or model family`), { statusCode: 400 });
  }
  const existing = getCustomRoles();
  if (existing.some(r => r.role === slug)) {
    throw Object.assign(new Error(`role '${slug}' already exists`), { statusCode: 409 });
  }
  if (!isValidRoleBinding(binding)) {
    throw Object.assign(new Error('binding must be a known tier binding {kind:"tier",tier} or a {kind,model} backend'), { statusCode: 400 });
  }
  const stored = binding.kind === 'tier' ? { kind: 'tier', tier: binding.tier } : persistBinding(binding);
  const cur = loadSync();
  const models = {
    ...(cur.models || {}),
    customRoles: [...existing, { role: slug, label: name }],
    roleBackend: { ...(cur.models?.roleBackend || {}), [slug]: stored },
  };
  await writeSettings({ ...cur, models });
  return { role: slug, label: name };
}

export async function setCustomRoleLabel(role, label) {
  const name = String(label || '').trim();
  if (!name) throw Object.assign(new Error('label is required'), { statusCode: 400 });
  const existing = getCustomRoles();
  if (!existing.some(r => r.role === role)) {
    throw Object.assign(new Error(`unknown custom role '${role}'`), { statusCode: 400 });
  }
  const cur = loadSync();
  const nextList = existing.map(r => r.role === role ? { role, label: name } : r);
  const models = { ...(cur.models || {}), customRoles: nextList };
  await writeSettings({ ...cur, models });
  return { role, label: name };
}

// Remove a custom role and its binding. Returns false if no such custom role.
export async function removeCustomRole(role) {
  const existing = getCustomRoles();
  if (!existing.some(r => r.role === role)) return false;
  const cur = loadSync();
  const nextList = existing.filter(r => r.role !== role);
  const roleBackend = { ...(cur.models?.roleBackend || {}) };
  delete roleBackend[role];
  const models = { ...(cur.models || {}), customRoles: nextList, roleBackend };
  await writeSettings({ ...cur, models });
  return true;
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
