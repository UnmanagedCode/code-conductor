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
  MANAGED_BACKENDS, MANAGED_BACKEND_IDS, CLAUDE_BACKEND_ID } from './modelVersions.js';
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

// ── Backend registry ─────────────────────────────────────────────────────
// Models group: the user-manageable backend registry, persisted as
// `models.backends: [{ id, label, template, env:[{key,value}] }]`. A backend is
// a launch recipe — see MANAGED_BACKENDS in modelVersions.js for the record
// contract and `resolveBackendLaunch` in claudeLauncher.js for the one place
// `template` is consumed.
//
// Managed rows are fully CODE-authoritative: id/label/template/env/managed all
// come from MANAGED_BACKENDS — nothing on a managed row is read from the store.
// So the built-in `ollama` template can't drift, `claude` always exists, and a
// fresh install (no settings.json) still has both rows.
const BACKEND_ID_RE = /^[a-z][a-z0-9-]*$/;
const BACKEND_ID_MAX = 40;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnv(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const key = String(e.key ?? '').trim();
    if (!ENV_KEY_RE.test(key)) continue;
    out.push({ key, value: String(e.value ?? '') });
  }
  return out;
}

export function getBackends() {
  const s = loadSync();
  const stored = Array.isArray(s.models?.backends) ? s.models.backends : [];
  // Managed rows first, in catalog order, fully code-authoritative — their
  // id/label/template/env all come from MANAGED_BACKENDS. Nothing on a managed
  // row is read from the store; any stored managed {id, env} entry is dead data
  // (stripped by migration 0024) and ignored here.
  const out = MANAGED_BACKENDS.map(m => ({ ...m }));
  for (const b of stored) {
    if (!b || typeof b.id !== 'string' || !b.id) continue;
    if (MANAGED_BACKEND_IDS.includes(b.id)) continue;
    out.push({
      id: b.id,
      label: typeof b.label === 'string' && b.label ? b.label : b.id,
      template: typeof b.template === 'string' ? b.template : '',
      env: parseEnv(b.env),
      managed: false,
    });
  }
  return out;
}

export function getBackend(id) {
  return getBackends().find(b => b.id === id) ?? null;
}

export function isKnownBackend(id) {
  return typeof id === 'string' && getBackends().some(b => b.id === id);
}

// Backends a custom model (and therefore a non-Claude binding) can name: every
// SUBSTITUTION backend. The identity `claude` backend is excluded — its models
// are the MODEL_FAMILIES catalog, not user rows.
export function getSubstitutionBackends() {
  return getBackends().filter(b => b.id !== CLAUDE_BACKEND_ID);
}

// `requireTemplate` is true for USER rows: a blank template would make the row a
// bare-`claude` alias that runs on the real Anthropic account while being treated
// as a substitution backend everywhere (unmonitored usage-window domain ⇒ no
// overage protection, no cost_usd ⇒ `—` in #costs, plus a forced
// CLAUDE_CODE_MAX_CONTEXT_TOKENS on a genuine Claude session). The managed `claude`
// row already provides identity behaviour, so such an alias adds nothing but that
// hazard. Managed rows are exempt — `claude`'s blank template comes from code.
function validateBackendFields({ label, template, env }, { requireTemplate = false } = {}) {
  const cleanLabel = String(label ?? '').trim();
  if (!cleanLabel) throw Object.assign(new Error('label is required'), { statusCode: 400 });
  const cleanTemplate = String(template ?? '').trim();
  if (requireTemplate && !cleanTemplate) {
    throw Object.assign(
      new Error(`template is required — a backend with no template would run the Claude CLI itself while being treated as a separate provider (no overage protection, no cost tracking); bind the built-in '${CLAUDE_BACKEND_ID}' backend for that`),
      { statusCode: 400 },
    );
  }
  if (Array.isArray(env)) {
    for (const e of env) {
      const key = String(e?.key ?? '').trim();
      if (!ENV_KEY_RE.test(key)) {
        throw Object.assign(new Error(`env key '${key}' must match ${ENV_KEY_RE.source}`), { statusCode: 400 });
      }
    }
  }
  return { label: cleanLabel, template: cleanTemplate, env: parseEnv(env) };
}

// Persist only the user's rows — managed rows are fully code-authoritative
// (id/label/template/env), so they are never stored.
async function writeBackends(list) {
  const cur = loadSync();
  const next = { ...cur, models: { ...(cur.models || {}), backends: list } };
  await writeSettings(next);
}

function storedBackends() {
  const s = loadSync();
  return Array.isArray(s.models?.backends) ? s.models.backends.filter(b => b && typeof b.id === 'string' && b.id) : [];
}

export async function addBackend({ id, label, template, env } = {}) {
  const cleanId = String(id ?? '').trim();
  if (!BACKEND_ID_RE.test(cleanId) || cleanId.length > BACKEND_ID_MAX) {
    throw Object.assign(new Error(`id must match ${BACKEND_ID_RE.source} (max ${BACKEND_ID_MAX} chars)`), { statusCode: 400 });
  }
  if (isKnownBackend(cleanId)) {
    throw Object.assign(new Error(`backend '${cleanId}' already exists`), { statusCode: 409 });
  }
  const fields = validateBackendFields({ label, template, env }, { requireTemplate: true });
  const entry = { id: cleanId, ...fields };
  await writeBackends([...storedBackends(), entry]);
  return { ...entry, managed: false };
}

// Managed rows are fully read-only — their label/template/env are all owned by
// MANAGED_BACKENDS. A user row accepts all three.
export async function updateBackend(id, { label, template, env } = {}) {
  const existing = getBackend(id);
  if (!existing) return null;
  if (existing.managed) {
    if (label !== undefined || template !== undefined || env !== undefined) {
      throw Object.assign(
        new Error(`backend '${id}' is built in — its label, template, and env cannot be edited`),
        { statusCode: 400 },
      );
    }
    return getBackend(id); // no-op PATCH on a read-only row
  }
  const stored = storedBackends();
  const fields = validateBackendFields({
    label: label ?? existing.label,
    template: template ?? existing.template,
    env: env ?? existing.env,
  }, { requireTemplate: true });
  await writeBackends([...stored.filter(b => b.id !== id), { id, ...fields }]);
  return getBackend(id);
}

// LIVE instances using each backend, injected by server.js
// (`setLiveBackendsProvider(() => instances.liveBackendUsage())`) so this
// low-level store never imports the instance registry — same seam shape as
// pluginRolesProvider below. Each entry: {backend, sessionId}. Default []
// keeps unit tests / headless runs (no manager) working.
let liveBackendsProvider = () => [];
export function setLiveBackendsProvider(fn) {
  liveBackendsProvider = typeof fn === 'function' ? fn : (() => []);
}
function liveBackendUsage() {
  try {
    const list = liveBackendsProvider();
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// Removing a backend NEVER cascades: a backend still referenced by a custom
// model — or still carried by a TRACKED instance — is refused (409, naming them)
// so nothing is deleted behind the user's back and no session is left pointing at
// a backend that no longer exists (which would otherwise launch the real `claude`
// on its next respawn). liveBackendUsage() deliberately counts exited instances
// too (still respawnable), so the remedy in the message is archiving/deleting the
// session — killing it leaves it in the registry's byId and re-trips this 409.
// Once nothing references it, any tier/role left pointing at one of its models
// reverts through the normal dead-binding path (see getTierBackend).
export async function removeBackend(id) {
  const existing = getBackend(id);
  if (!existing) return false;
  if (existing.managed) {
    throw Object.assign(new Error(`backend '${id}' is built in and cannot be removed`), { statusCode: 400 });
  }
  const bound = getCustomModels().filter(m => m.backend === id).map(m => m.model);
  if (bound.length) {
    throw Object.assign(
      new Error(`backend '${id}' still has custom models bound to it (${bound.join(', ')}) — remove them first`),
      { statusCode: 409 },
    );
  }
  const live = liveBackendUsage().filter(u => u && u.backend === id).map(u => u.sessionId || '(unknown session)');
  if (live.length) {
    throw Object.assign(
      new Error(`backend '${id}' is still in use by ${live.length} open session${live.length === 1 ? '' : 's'} (${live.join(', ')}) — archive or delete ${live.length === 1 ? 'it' : 'them'} first (killing a session leaves it respawnable)`),
      { statusCode: 409 },
    );
  }
  await writeBackends(storedBackends().filter(b => b.id !== id));
  return true;
}

// ── Custom models ────────────────────────────────────────────────────────
// Models group: custom models served by a substitution backend. Persisted as
// `models.customModels: [{ label, model, backend, contextWindow }]`, where
// `model` is the backend's own model id (an Ollama tag, say) and IS the
// identity — a given model id belongs to exactly one backend. This is the
// catalog the Settings model selector lists for a non-Claude backend.
export function getCustomModels() {
  const s = loadSync();
  const list = s.models?.customModels;
  if (!Array.isArray(list)) return [];
  return list.filter(m => m && typeof m.model === 'string' && typeof m.backend === 'string');
}

// True if `model` is bindable on `backend`: the user added it there, or it's a
// curated cloud preset of the built-in `ollama` backend (bindable with no prior
// "Add" step). The curated catalog is scoped to that one backend by design.
export function isKnownBackendModel(backend, model) {
  if (typeof backend !== 'string' || typeof model !== 'string' || !model) return false;
  if (!isKnownBackend(backend) || backend === CLAUDE_BACKEND_ID) return false;
  if (getCustomModels().some(m => m.backend === backend && m.model === model)) return true;
  return backend === 'ollama' && isKnownOllamaCloudModel(model);
}

// The backend that serves a non-Claude model id, or null when nothing does. A
// user row wins over the curated catalog (an override of a preset). Used by MCP
// spawn_instance so a caller can pass a bare model id and still land on the right
// backend.
export function backendForModel(model) {
  if (typeof model !== 'string' || !model) return null;
  const custom = getCustomModels().find(m => m.model === model);
  if (custom && isKnownBackend(custom.backend)) return custom.backend;
  if (isKnownOllamaCloudModel(model) && isKnownBackend('ollama')) return 'ollama';
  return null;
}

// Native context window (raw tokens) for a non-Claude model id, or null when
// unknown. Custom models win over the curated catalog (a user override of a
// preset). The server always holds the full model id in Instance.model, so an
// exact match suffices here (the client resolver additionally tolerates the
// bare base name the CLI reports — see customContextWindowFor in
// public/models.js).
export function contextWindowForModel(model) {
  if (typeof model !== 'string' || !model) return null;
  const custom = getCustomModels().find(m => m.model === model);
  if (custom && Number.isFinite(custom.contextWindow)) return custom.contextWindow;
  const preset = OLLAMA_CLOUD_MODELS.find(m => m.model === model);
  if (preset && Number.isFinite(preset.contextWindow)) return preset.contextWindow;
  return null;
}

// `contextWindow` is REQUIRED and must be a positive, finite number of raw tokens
// (stored `Math.round`ed): it
// drives the header ctx bar plus CLAUDE_CODE_AUTO_COMPACT_WINDOW and
// CLAUDE_CODE_MAX_CONTEXT_TOKENS at spawn, and guessing it wrong silently
// truncates or over-fills the window. `backend` must name a substitution
// backend (never `claude`).
export async function addCustomModel({ label, model, backend, contextWindow } = {}) {
  const cleanLabel = String(label || '').trim();
  const cleanModel = String(model || '').trim();
  const cleanBackend = String(backend || '').trim();
  if (!cleanLabel || !cleanModel || !cleanBackend) {
    throw Object.assign(new Error('label, model, and backend are required'), { statusCode: 400 });
  }
  if (cleanBackend === CLAUDE_BACKEND_ID || !isKnownBackend(cleanBackend)) {
    throw Object.assign(
      new Error(`backend '${cleanBackend}' is not a known custom-model backend — add it in Settings → Backends`),
      { statusCode: 400 },
    );
  }
  const cw = Number(contextWindow);
  if (!Number.isFinite(cw) || cw <= 0) {
    throw Object.assign(new Error('contextWindow is required and must be a positive number of tokens'), { statusCode: 400 });
  }
  const entry = { label: cleanLabel, model: cleanModel, backend: cleanBackend, contextWindow: Math.round(cw) };
  const cur = loadSync();
  // The model id is the identity — re-adding it updates the row in place.
  const nextList = getCustomModels().filter(m => m.model !== cleanModel).concat([entry]);
  const next = { ...cur, models: { ...(cur.models || {}), customModels: nextList } };
  await writeSettings(next);
  return entry;
}

// Remove a custom model by its model id. Any tier still bound to it falls back
// gracefully: getTierBackend's validation reverts the now-unknown binding to
// the tier's default Claude backend on the next read.
export async function removeCustomModel(model) {
  const cur = loadSync();
  const existing = getCustomModels();
  const nextList = existing.filter(m => m.model !== model);
  if (nextList.length === existing.length) return false;
  const next = { ...cur, models: { ...(cur.models || {}), customModels: nextList } };
  await writeSettings(next);
  return true;
}

// True if a {backend, model} binding names a real, currently-available backend.
function isValidBinding(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.backend === CLAUDE_BACKEND_ID) return isKnownClaudeModel(b.model);
  return isKnownBackendModel(b.backend, b.model);
}

// Reconstruct the persisted shape of a concrete {backend, model} binding,
// keeping only the fields that matter. A Claude binding on a
// user-selectable-window Sonnet (4.x) carries its chosen `window`
// ('1m'|'200k'); every other binding (any substitution backend,
// Opus/Haiku/Fable, fixed-window Sonnet 5) stores no window — those ignore it,
// so persisting one would be misleading noise.
function persistBinding(b) {
  const out = { backend: b.backend, model: b.model };
  if (b.backend === CLAUDE_BACKEND_ID && sonnetWindowSelectable(b.model) && (b.window === '1m' || b.window === '200k')) {
    out.window = b.window;
  }
  return out;
}

// Models group: tier → {backend, model} binding. `backend` is 'claude' (model =
// a MODEL_FAMILIES version id) or any other registry id (model = one of that
// backend's custom models / curated presets).
//
// IMPORTANT: a valid binding is returned verbatim (no silent revert); only an
// invalid/dead binding (unknown version, or a since-removed model or backend)
// falls back to the tier's default Claude backend.
export function getTierBackend(tier) {
  const s = loadSync();
  const stored = s.models?.tierBackend?.[tier];
  return isValidBinding(stored) ? stored : DEFAULT_TIER_BACKEND[tier];
}

export async function setTierBackend(tier, backend) {
  if (!isKnownTier(tier) || !isValidBinding(backend)) {
    throw Object.assign(new Error('tierBackend must be {backend, model} naming a known backend + model'), { statusCode: 400 });
  }
  const cur = loadSync();
  const nextTierBackend = { ...(cur.models?.tierBackend || {}), [tier]: persistBinding(backend) };
  const next = { ...cur, models: { ...(cur.models || {}), tierBackend: nextTierBackend } };
  await writeSettings(next);
  return nextTierBackend;
}

// Roles group: role → binding. A binding is EITHER a tier binding
// ({kind:'tier', tier}) or a concrete {backend, model} pair (the same shape a
// tier binds to). The two are told apart by `kind === 'tier'`; a tier binding
// validates via isKnownTier, a concrete one via isValidBinding.
export function isValidRoleBinding(b) {
  if (b && typeof b === 'object' && b.kind === 'tier') return isKnownTier(b.tier);
  return isValidBinding(b);
}

// A role's fallback binding when nothing valid is stored. Built-in roles use
// their catalog default; a custom role (no catalog default) falls back to the
// current default spawn tier so it always resolves to a live backend.
function defaultRoleBinding(role) {
  return DEFAULT_ROLE_BINDING[role] ?? { kind: 'tier', tier: getDefaultSpawnTier() };
}

// Role NAME matching is case-insensitive (a spawn caller may type `MyRole` for a
// role stored as `myrole`). Names are stored/displayed as the user typed them,
// but matched and deduped by lowercase. These helpers return the canonical
// STORED name (built-in or custom) for a case-insensitive lookup, or undefined.
function canonicalBuiltinRole(role) {
  const lc = String(role).toLowerCase();
  return ROLES.find(r => r.role.toLowerCase() === lc)?.role;
}
function canonicalCustomRole(role) {
  const lc = String(role).toLowerCase();
  return getCustomRoles().find(r => r.toLowerCase() === lc);
}
// The canonical STORED name for a plugin role (the exact '<plugin-id>/<slug>'
// id from the live provider), matched case-insensitively, or undefined. Used
// by setRoleBinding so a case-variant override targets the same roleBackend
// key as a canonical one (parity with the built-in/custom canonicalization
// above).
function canonicalPluginRole(role) {
  const lc = String(role).toLowerCase();
  return getPluginRoles().find(r => r.role.toLowerCase() === lc)?.role;
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

// Effective binding for ANY role (plugin/built-in/custom): the tier or
// {backend,model} binding that governs the role today, NOT resolved to a concrete
// backend. A valid user override wins; else the manifest binding (plugin) or
// the stored/default binding (built-in/custom). Single source for both the
// Settings payload (which shows the binding as-is) and resolveRoleBackend
// (which then resolves it to a concrete backend).
export function effectiveRoleBinding(role) {
  const lc = String(role).toLowerCase();
  const pr = getPluginRoles().find(r => r.role.toLowerCase() === lc);
  if (pr) {
    const override = loadSync().models?.roleBackend?.[pr.role];
    return isValidRoleBinding(override) ? override : pr.binding;
  }
  const canonical = canonicalBuiltinRole(role) ?? canonicalCustomRole(role);
  return canonical ? getRoleBinding(canonical) : defaultRoleBinding(role);
}

export async function setRoleBinding(role, binding) {
  // Canonicalize to the stored name so a case-variant rebind updates the same
  // roleBackend key rather than creating a duplicate. Plugin roles are included
  // — a user override of a plugin role's manifest binding is persisted under
  // its exact '<plugin-id>/<slug>' id and beats the manifest at resolve time.
  const canonical = canonicalBuiltinRole(role) ?? canonicalCustomRole(role) ?? canonicalPluginRole(role);
  if (!canonical || !isValidRoleBinding(binding)) {
    throw Object.assign(new Error('roleBackend must name a built-in, custom, or plugin role and be a known tier binding {kind:"tier",tier} or a {backend,model} pair'), { statusCode: 400 });
  }
  const stored = binding.kind === 'tier'
    ? { kind: 'tier', tier: binding.tier }
    : persistBinding(binding);
  const cur = loadSync();
  const nextRoleBackend = { ...(cur.models?.roleBackend || {}), [canonical]: stored };
  const next = { ...cur, models: { ...(cur.models || {}), roleBackend: nextRoleBackend } };
  await writeSettings(next);
  return nextRoleBackend;
}

// Resolve a role to a concrete {backend, model}. Takes the effective binding (a
// valid user override wins, else manifest/stored/default — see
// effectiveRoleBinding) and resolves it: a tier binding delegates to
// getTierBackend (so a role→tier→dead-custom chain still reverts correctly); a
// concrete binding is returned directly. Never throws — an unknown role or a
// disabled plugin's role falls back through effectiveRoleBinding to the default
// spawn tier.
//
// The dead-Claude re-guard below protects the plugin MANIFEST claude binding
// path: a manifest binding is validated at plugin load, but the model catalog
// can move on (a Claude version retired) before this resolve, and unlike stored
// bindings (getRoleBinding reverts) or valid overrides (isValidRoleBinding
// gates) the manifest binding is NOT re-validated by effectiveRoleBinding.
// Guarding here keeps a retired plugin claude id from spawning — it reverts to
// the default spawn tier's backend instead. (A plugin manifest can only bind
// the `claude` backend; tier bindings and valid non-manifest bindings never trip
// the guard.)
export function resolveRoleBackend(role) {
  const b = effectiveRoleBinding(role);
  if (b.kind === 'tier') return getTierBackend(b.tier);
  if (b.backend === CLAUDE_BACKEND_ID && !isKnownClaudeModel(b.model)) {
    return getTierBackend(getDefaultSpawnTier());
  }
  return persistBinding(b);
}

// ── Custom + plugin roles ────────────────────────────────────────────────
// Plugin-owned roles are LIVE-DERIVED from enabled plugins (never persisted),
// mirroring plugin conventions: the provider is injected by server.js
// (`setPluginRolesProvider(() => pluginHost.roles())`) so this low-level store
// never imports the plugin registry. Each entry: {role:'<plugin-id>/<slug>',
// label, binding:{kind:'tier',tier}|{backend,model}, plugin:id}. Default [] keeps
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

// User custom roles: persisted as `models.customRoles: [name]` — a name-only
// string list (no separate label; the name IS the display). The binding lives in
// `models.roleBackend[name]` exactly like a built-in role, so binding edits reuse
// setRoleBinding/getRoleBinding unchanged. A name is case-preserved but matched
// case-insensitively; it must be disjoint (case-insensitively) from tiers /
// built-in roles / family aliases / other custom + plugin roles. '/' is reserved
// for plugin namespacing (the regex forbids it). This name rule is DELIBERATELY
// distinct from the lowercase plugin-slug rule (manifest.js) — a custom role name
// is a user-facing, case-preserving label, not a lowercase identifier slug.
const CUSTOM_ROLE_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const CUSTOM_ROLE_MAX = 40;

export function getCustomRoles() {
  const s = loadSync();
  const list = s.models?.customRoles;
  return Array.isArray(list) ? list.filter(r => typeof r === 'string' && r) : [];
}

// The full live role catalog: built-in + user custom + plugin-owned. Built-in and
// plugin entries carry a display `label`; a custom entry is name-only ({role}).
// Single source for the Settings payload and the resolution guard.
export function getAllRoles() {
  return [
    ...ROLES.map(r => ({ role: r.role, label: r.label, builtin: true })),
    ...getCustomRoles().map(role => ({ role })),
    ...getPluginRoles().map(r => ({ role: r.role, label: r.label, plugin: r.plugin })),
  ];
}

// True if a role name resolves to a backend today (built-in, custom, or a
// currently-enabled plugin's role), matched case-insensitively. Used by
// spawnInstance in place of the static isKnownRole so custom/plugin roles are
// spawnable everywhere built-ins are.
export function isResolvableRole(role) {
  if (typeof role !== 'string' || !role) return false;
  const lc = role.toLowerCase();
  if (ROLES.some(r => r.role.toLowerCase() === lc)) return true;
  if (getCustomRoles().some(r => r.toLowerCase() === lc)) return true;
  return getPluginRoles().some(r => r.role.toLowerCase() === lc);
}

// Create a custom role (name-only). Binding defaults to the built-in `powerful`
// tier; callers rebind afterwards via setRoleBinding. Rejects a name that
// case-insensitively collides with a tier, built-in role, family alias, or an
// existing custom role. (Plugin roles are always '<id>/<slug>' and CUSTOM_ROLE_RE
// forbids '/', so a custom name can never equal a plugin role name — no guard
// needed for that.)
export async function addCustomRole({ role, binding } = {}) {
  const name = String(role || '').trim();
  if (!CUSTOM_ROLE_RE.test(name) || name.length > CUSTOM_ROLE_MAX) {
    throw Object.assign(new Error('role must match ^[A-Za-z][A-Za-z0-9-]*$ (max 40 chars)'), { statusCode: 400 });
  }
  const lc = name.toLowerCase();
  if (isKnownTier(lc) || isKnownRole(lc) || isKnownFamily(lc)) {
    throw Object.assign(new Error(`name '${name}' collides with a built-in tier, role, or model family`), { statusCode: 400 });
  }
  if (getCustomRoles().some(r => r.toLowerCase() === lc)) {
    throw Object.assign(new Error(`role '${name}' already exists`), { statusCode: 409 });
  }
  const b = binding ?? { kind: 'tier', tier: 'powerful' };
  if (!isValidRoleBinding(b)) {
    throw Object.assign(new Error('binding must be a known tier binding {kind:"tier",tier} or a {backend,model} pair'), { statusCode: 400 });
  }
  const stored = b.kind === 'tier' ? { kind: 'tier', tier: b.tier } : persistBinding(b);
  const cur = loadSync();
  const models = {
    ...(cur.models || {}),
    customRoles: [...getCustomRoles(), name],
    roleBackend: { ...(cur.models?.roleBackend || {}), [name]: stored },
  };
  await writeSettings({ ...cur, models });
  return { role: name };
}

// Remove a custom role and its binding (case-insensitive). Returns false if no
// matching custom role.
export async function removeCustomRole(role) {
  const canonical = canonicalCustomRole(role);
  if (canonical === undefined) return false;
  const cur = loadSync();
  const nextList = getCustomRoles().filter(r => r !== canonical);
  const roleBackend = { ...(cur.models?.roleBackend || {}) };
  delete roleBackend[canonical];
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
// COMPACT_K_MIN matches the Claude Code CLI's CLAUDE_CODE_AUTO_COMPACT_WINDOW floor (Math.max(100000, effective)) — a lower minimum here would be a silent no-op once it reaches the CLI.
// Clamped on write only (setConductorCompactWindow), matching this file's other
// clamped settings (e.g. setOverageThreshold) — a pre-existing persisted value
// below the floor is normalized once via migrations/0023-clamp-compact-window-floor.mjs,
// not re-clamped on every read.
const COMPACT_K_MIN  = 100;
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
