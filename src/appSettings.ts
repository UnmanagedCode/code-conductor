// Persistent app-level settings, stored at `<orchStoreRoot()>/settings.json`
// (the workspace-wide central store). Currently holds the active transcribe
// model; structured as a namespaced object so future settings groups slot in
// without a schema migration.
//
// Reads are served from an in-memory cache (lazily seeded from disk with a
// synchronous read — the file is tiny and the read paths, e.g. resolving the
// whisper model in transcribe.ts, are not hot). Writes are atomic
// (tmp → rename) and refresh the cache.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot, writeFileAtomic } from './projects.ts';
import {
  CAPABILITY_TIERS, DEFAULT_TIER_BACKEND, isKnownTier, isKnownClaudeModel,
  ROLES, DEFAULT_ROLE_BINDING, isKnownRole, isKnownFamily, claudeContextWindowTokens,
  MANAGED_BACKENDS, MANAGED_BACKEND_IDS, CLAUDE_BACKEND_ID,
  type BackendRecord, type BackendBinding, type TierBinding, type TierName, type RoleName,
} from './modelVersions.ts';
import { OLLAMA_CLOUD_MODELS, isKnownOllamaCloudModel } from './ollamaCloudModels.ts';
import { DEFAULT_EFFORT, INHERIT_EFFORT, isKnownEffort, type EffortLevel } from './effortLevels.ts';

// The on-disk settings document, typed loosely: every leaf is `unknown` because
// the file is app-owned but pre-dates this module's conversion and can hold
// legacy/foreign values. Reads narrow at point of use (fail-safe defaults);
// writes always write well-formed values back.
interface StoredSettings {
  transcribe?: { model?: unknown };
  tts?: { enabled?: unknown; voice?: unknown; rate?: unknown };
  models?: {
    onOverage?: unknown;
    enabledTiers?: Record<string, unknown>;
    defaultTier?: unknown;
    backends?: unknown;
    customModels?: unknown;
    tierBackend?: Record<string, unknown>;
    roleBackend?: Record<string, unknown>;
    tierEffort?: Record<string, unknown>;
    roleEffort?: Record<string, unknown>;
    customRoles?: unknown;
    conductorCompactWindowEnabled?: unknown;
    conductorCompactWindowK?: unknown;
    overageThresholdEnabled?: unknown;
    overageThresholdPct?: unknown;
  };
  spawn?: { debugByDefault?: unknown };
}

function settingsPath(): string {
  return path.join(orchStoreRoot(), 'settings.json');
}

let cache: StoredSettings | null = null;
let cachedFor: string | null = null; // settingsPath() the cache was seeded from — guards test env swaps

function loadSync(): StoredSettings {
  const p = settingsPath();
  if (cache !== null && cachedFor === p) return cache;
  try {
    const obj: unknown = JSON.parse(readFileSync(p, 'utf8'));
    cache = (typeof obj === 'object' && obj !== null ? obj : {}) as StoredSettings;
  } catch {
    cache = {};
  }
  cachedFor = p;
  return cache;
}

export function readSettings(): StoredSettings {
  return loadSync();
}

async function writeSettings(next: StoredSettings): Promise<void> {
  const p = settingsPath();
  await writeFileAtomic(p, JSON.stringify(next, null, 2));
  cache = next;
  cachedFor = p;
}

export function getTranscribeModel(): string | null {
  const s = loadSync();
  const m = s.transcribe?.model;
  return typeof m === 'string' ? m : null;
}

export async function setTranscribeModel(name: string): Promise<string> {
  const cur = loadSync();
  const next = { ...cur, transcribe: { ...(cur.transcribe || {}), model: name } };
  await writeSettings(next);
  return name;
}

// TTS group: the `tts` namespace holds { enabled, voice, rate }.
// `enabled` gates auto-speak of finalized assistant messages; `voice` is the
// active Piper voice name (null → built-in default, see ttsModels.ts); `rate`
// is the playback speed multiplier (1.0 = natural). Each setter spreads the
// existing namespace so it never clobbers `transcribe`/`models`.
const TTS_RATE_MIN = 0.5;
const TTS_RATE_MAX = 2.0;

export function getTtsEnabled(): boolean {
  const s = loadSync();
  return Boolean(s.tts?.enabled);
}

export async function setTtsEnabled(enabled: unknown): Promise<boolean> {
  const cur = loadSync();
  const next = { ...cur, tts: { ...(cur.tts || {}), enabled: !!enabled } };
  await writeSettings(next);
  return !!enabled;
}

export function getTtsVoice(): string | null {
  const s = loadSync();
  const v = s.tts?.voice;
  return typeof v === 'string' ? v : null;
}

export async function setTtsVoice(name: string): Promise<string> {
  const cur = loadSync();
  const next = { ...cur, tts: { ...(cur.tts || {}), voice: name } };
  await writeSettings(next);
  return name;
}

export function getTtsRate(): number {
  const s = loadSync();
  const r = s.tts?.rate;
  return typeof r === 'number' && Number.isFinite(r) ? r : 1.0;
}

export async function setTtsRate(rate: unknown): Promise<number> {
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
type OnOverageAction = 'none' | 'stop' | 'stop-resume';

export function getOnOverageAction(): OnOverageAction {
  const s = loadSync();
  const v = s.models?.onOverage;
  return v === 'stop' || v === 'stop-resume' ? v : 'none';
}

export async function setOnOverageAction(action: unknown): Promise<OnOverageAction> {
  const val = typeof action === 'string' && VALID_ON_OVERAGE.includes(action) ? action as OnOverageAction : 'none';
  const cur = loadSync();
  const models = { ...(cur.models || {}), onOverage: val };
  await writeSettings({ ...cur, models });
  return val;
}

// Spawn group: debugByDefault gates whether a newly spawned instance mirrors
// raw CLI traffic to the debug dir when the spawn call doesn't name `debug`
// explicitly (see InstanceManager._doCreate). Off by default — strictly opt-in.
export function getDebugByDefault(): boolean {
  const s = loadSync();
  return Boolean(s.spawn?.debugByDefault);
}

export async function setDebugByDefault(enabled: unknown): Promise<boolean> {
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
const DEFAULT_SPAWN_TIER: TierName = 'powerful';

export function getEnabledTiers(): Record<string, boolean> {
  const s = loadSync();
  const merged: Record<string, boolean> = { ...ENABLED_TIERS_DEFAULTS };
  if (s.models?.enabledTiers !== undefined) {
    for (const [k, v] of Object.entries(s.models.enabledTiers)) {
      merged[k] = typeof v === 'boolean' ? v : true;
    }
  }
  return merged;
}

// Disable/enable one tier. Guards against disabling the last enabled tier.
// Auto-reassigns defaultTier when the disabled tier is the current default.
export async function setTierEnabled(tier: TierName, enabled: unknown): Promise<{ enabledTiers: Record<string, boolean>; defaultSpawnTier: string }> {
  const cur = loadSync();
  const current = getEnabledTiers();

  if (!enabled) {
    const remaining = CAPABILITY_TIERS.filter(t => t.tier !== tier && current[t.tier] !== false);
    if (remaining.length === 0) {
      throw httpError(400, 'cannot disable the last enabled tier');
    }
  }

  const nextEnabled = { ...current, [tier]: !!enabled };

  let nextDefault = typeof cur.models?.defaultTier === 'string' ? cur.models.defaultTier : DEFAULT_SPAWN_TIER;
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

export function getDefaultSpawnTier(): TierName {
  const s = loadSync();
  const v = s.models?.defaultTier;
  return typeof v === 'string' && isKnownTier(v) ? v as TierName : DEFAULT_SPAWN_TIER;
}

export async function setDefaultSpawnTier(tier: unknown): Promise<TierName> {
  const val = typeof tier === 'string' && isKnownTier(tier) ? tier as TierName : DEFAULT_SPAWN_TIER;
  const cur = loadSync();
  const next = { ...cur, models: { ...(cur.models || {}), defaultTier: val } };
  await writeSettings(next);
  return val;
}

// ── Backend registry ─────────────────────────────────────────────────────
// Models group: the user-manageable backend registry, persisted as
// `models.backends: [{ id, label, template, env:[{key,value}] }]`. A backend is
// a launch recipe — see MANAGED_BACKENDS in modelVersions.ts for the record
// contract and `resolveBackendLaunch` in claudeLauncher.ts for the one place
// `template` is consumed.
//
// Managed rows are fully CODE-authoritative: id/label/template/env/managed all
// come from MANAGED_BACKENDS — nothing on a managed row is read from the store.
// So the built-in `ollama` template can't drift, `claude` always exists, and a
// fresh install (no settings.json) still has both rows.
const BACKEND_ID_RE = /^[a-z][a-z0-9-]*$/;
const BACKEND_ID_MAX = 40;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnv(list: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as { key?: unknown; value?: unknown };
    const key = String(rec.key ?? '').trim();
    if (!ENV_KEY_RE.test(key)) continue;
    out.push({ key, value: String(rec.value ?? '') });
  }
  return out;
}

export function getBackends(): BackendRecord[] {
  const s = loadSync();
  const stored = Array.isArray(s.models?.backends) ? s.models.backends : [];
  // Managed rows first, in catalog order, fully code-authoritative — their
  // id/label/template/env all come from MANAGED_BACKENDS. Nothing on a managed
  // row is read from the store; any stored managed {id, env} entry is dead data
  // (stripped by migration 0024) and ignored here.
  const out: BackendRecord[] = MANAGED_BACKENDS.map(m => ({ ...m }));
  for (const b of stored) {
    if (!b || typeof b !== 'object') continue;
    const rec = b as { id?: unknown; label?: unknown; template?: unknown; env?: unknown };
    if (typeof rec.id !== 'string' || !rec.id) continue;
    if (MANAGED_BACKEND_IDS.includes(rec.id)) continue;
    out.push({
      id: rec.id,
      label: typeof rec.label === 'string' && rec.label ? rec.label : rec.id,
      template: typeof rec.template === 'string' ? rec.template : '',
      env: parseEnv(rec.env),
      managed: false,
    });
  }
  return out;
}

export function getBackend(id: string): BackendRecord | null {
  return getBackends().find(b => b.id === id) ?? null;
}

export function isKnownBackend(id: unknown): boolean {
  return typeof id === 'string' && getBackends().some(b => b.id === id);
}

// Backends a custom model (and therefore a non-Claude binding) can name: every
// SUBSTITUTION backend. The identity `claude` backend is excluded — its models
// are the MODEL_FAMILIES catalog, not user rows.
export function getSubstitutionBackends(): BackendRecord[] {
  return getBackends().filter(b => b.id !== CLAUDE_BACKEND_ID);
}

// `requireTemplate` is true for USER rows: a blank template would make the row a
// bare-`claude` alias that runs on the real Anthropic account while being treated
// as a substitution backend everywhere (unmonitored usage-window domain ⇒ no
// overage protection, no cost_usd ⇒ `—` in #costs, plus a forced
// CLAUDE_CODE_MAX_CONTEXT_TOKENS on a genuine Claude session). The managed `claude`
// row already provides identity behaviour, so such an alias adds nothing but that
// hazard. Managed rows are exempt — `claude`'s blank template comes from code.
function validateBackendFields(
  { label, template, env }: { label: unknown; template: unknown; env: unknown },
  { requireTemplate = false }: { requireTemplate?: boolean } = {},
): { label: string; template: string; env: Array<{ key: string; value: string }> } {
  const cleanLabel = String(label ?? '').trim();
  if (!cleanLabel) throw httpError(400, 'label is required');
  const cleanTemplate = String(template ?? '').trim();
  if (requireTemplate && !cleanTemplate) {
    throw httpError(
      400,
      `template is required — a backend with no template would run the Claude CLI itself while being treated as a separate provider (no overage protection, no cost tracking); bind the built-in '${CLAUDE_BACKEND_ID}' backend for that`,
    );
  }
  if (Array.isArray(env)) {
    for (const e of env) {
      const key = String(e?.key ?? '').trim();
      if (!ENV_KEY_RE.test(key)) {
        throw httpError(400, `env key '${key}' must match ${ENV_KEY_RE.source}`);
      }
    }
  }
  return { label: cleanLabel, template: cleanTemplate, env: parseEnv(env) };
}

// Persist only the user's rows — managed rows are fully code-authoritative
// (id/label/template/env), so they are never stored.
async function writeBackends(list: Array<Record<string, unknown>>): Promise<void> {
  const cur = loadSync();
  const next = { ...cur, models: { ...(cur.models || {}), backends: list } };
  await writeSettings(next);
}

function storedBackends(): Array<Record<string, unknown>> {
  const s = loadSync();
  const list = s.models?.backends;
  if (!Array.isArray(list)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const rec = b as Record<string, unknown>;
    if (typeof rec.id === 'string' && rec.id) out.push(rec);
  }
  return out;
}

export async function addBackend(input: { id?: unknown; label?: unknown; template?: unknown; env?: unknown } = {}): Promise<BackendRecord> {
  const { id, label, template, env } = input;
  const cleanId = String(id ?? '').trim();
  if (!BACKEND_ID_RE.test(cleanId) || cleanId.length > BACKEND_ID_MAX) {
    throw httpError(400, `id must match ${BACKEND_ID_RE.source} (max ${BACKEND_ID_MAX} chars)`);
  }
  if (isKnownBackend(cleanId)) {
    throw httpError(409, `backend '${cleanId}' already exists`);
  }
  const fields = validateBackendFields({ label, template, env }, { requireTemplate: true });
  const entry = { id: cleanId, ...fields };
  await writeBackends([...storedBackends(), entry]);
  return { ...entry, managed: false };
}

// Managed rows are fully read-only — their label/template/env are all owned by
// MANAGED_BACKENDS. A user row accepts all three.
export async function updateBackend(
  id: string,
  { label, template, env }: { label?: unknown; template?: unknown; env?: unknown } = {},
): Promise<BackendRecord | null> {
  const existing = getBackend(id);
  if (!existing) return null;
  if (existing.managed) {
    if (label !== undefined || template !== undefined || env !== undefined) {
      throw httpError(400, `backend '${id}' is built in — its label, template, and env cannot be edited`);
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

interface LiveBackendUsage {
  backend: string;
  sessionId: string | null;
}

// LIVE instances using each backend, injected by server.js
// (`setLiveBackendsProvider(() => instances.liveBackendUsage())`) so this
// low-level store never imports the instance registry — same seam shape as
// pluginRolesProvider below. Each entry: {backend, sessionId}. Default []
// keeps unit tests / headless runs (no manager) working.
let liveBackendsProvider: () => LiveBackendUsage[] = () => [];
export function setLiveBackendsProvider(fn: (() => LiveBackendUsage[]) | null | undefined): void {
  liveBackendsProvider = typeof fn === 'function' ? fn : (() => []);
}
function liveBackendUsage(): LiveBackendUsage[] {
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
export async function removeBackend(id: string): Promise<boolean> {
  const existing = getBackend(id);
  if (!existing) return false;
  if (existing.managed) {
    throw httpError(400, `backend '${id}' is built in and cannot be removed`);
  }
  const bound = getCustomModels().filter(m => m.backend === id).map(m => m.model);
  if (bound.length) {
    throw httpError(409, `backend '${id}' still has custom models bound to it (${bound.join(', ')}) — remove them first`);
  }
  const live = liveBackendUsage().filter(u => u && u.backend === id).map(u => u.sessionId || '(unknown session)');
  if (live.length) {
    throw httpError(
      409,
      `backend '${id}' is still in use by ${live.length} open session${live.length === 1 ? '' : 's'} (${live.join(', ')}) — archive or delete ${live.length === 1 ? 'it' : 'them'} first (killing a session leaves it respawnable)`,
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
interface CustomModelRecord {
  label?: unknown;
  model: string;
  backend: string;
  contextWindow?: unknown;
}

export function getCustomModels(): CustomModelRecord[] {
  const s = loadSync();
  const list = s.models?.customModels;
  if (!Array.isArray(list)) return [];
  const out: CustomModelRecord[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as { label?: unknown; model?: unknown; backend?: unknown; contextWindow?: unknown };
    if (typeof rec.model === 'string' && typeof rec.backend === 'string') {
      out.push({ label: rec.label, model: rec.model, backend: rec.backend, contextWindow: rec.contextWindow });
    }
  }
  return out;
}

// True if `model` is bindable on `backend`: the user added it there, or it's a
// curated cloud preset of the built-in `ollama` backend (bindable with no prior
// "Add" step). The curated catalog is scoped to that one backend by design.
export function isKnownBackendModel(backend: unknown, model: unknown): boolean {
  if (typeof backend !== 'string' || typeof model !== 'string' || !model) return false;
  if (!isKnownBackend(backend) || backend === CLAUDE_BACKEND_ID) return false;
  if (getCustomModels().some(m => m.backend === backend && m.model === model)) return true;
  return backend === 'ollama' && isKnownOllamaCloudModel(model);
}

// The backend that serves a non-Claude model id, or null when nothing does. A
// user row wins over the curated catalog (an override of a preset). Used by MCP
// spawn_instance so a caller can pass a bare model id and still land on the right
// backend.
export function backendForModel(model: unknown): string | null {
  if (typeof model !== 'string' || !model) return null;
  const custom = getCustomModels().find(m => m.model === model);
  if (custom && isKnownBackend(custom.backend)) return custom.backend;
  if (isKnownOllamaCloudModel(model) && isKnownBackend('ollama')) return 'ollama';
  return null;
}

// Native context window (raw tokens) for a non-Claude model id, or null when
// unknown. Custom models win over the curated catalog (a user override of a
// preset).
//
// The match is EXACT and load-bearing: a substitution model id is an opaque
// registry key, so `gpt-5.6-sol[1m]` is a different model from `gpt-5.6-sol`.
// Anything that strips a tag before reaching here turns a known window into a
// silent null — see canonicalizeModel's backend gate in modelVersions.ts.
export function contextWindowForModel(model: unknown): number | null {
  if (typeof model !== 'string' || !model) return null;
  const custom = getCustomModels().find(m => m.model === model);
  if (custom && typeof custom.contextWindow === 'number' && Number.isFinite(custom.contextWindow)) return custom.contextWindow;
  const preset = OLLAMA_CLOUD_MODELS.find(m => m.model === model);
  if (preset && Number.isFinite(preset.contextWindow)) return preset.contextWindow;
  return null;
}

// THE single place a session's context capacity is resolved, from the concrete
// {backend, exact model} pair. Returns raw tokens, or null when unknown — and
// null must be rendered as unknown, never replaced by a default, because a
// fabricated denominator reads as a real cap (a session with a fabricated 200k
// was observed processing >256k input tokens).
//
// Both arms require the EXACT model id: the Claude catalog tolerates a launch
// tag, the substitution registry does not tolerate its removal.
export function resolveContextWindowTokens(input: { backend?: unknown; model?: unknown } = {}): number | null {
  const { backend, model } = input;
  if (typeof model !== 'string' || !model) return null;
  if (backend === CLAUDE_BACKEND_ID) return claudeContextWindowTokens(model);
  return contextWindowForModel(model);
}

// `contextWindow` is REQUIRED and must be a positive, finite number of raw tokens
// (stored `Math.round`ed): it
// drives the header ctx bar plus CLAUDE_CODE_AUTO_COMPACT_WINDOW and
// CLAUDE_CODE_MAX_CONTEXT_TOKENS at spawn, and guessing it wrong silently
// truncates or over-fills the window. `backend` must name a substitution
// backend (never `claude`).
export async function addCustomModel(input: { label?: unknown; model?: unknown; backend?: unknown; contextWindow?: unknown } = {}): Promise<{ label: string; model: string; backend: string; contextWindow: number }> {
  const { label, model, backend, contextWindow } = input;
  const cleanLabel = String(label || '').trim();
  const cleanModel = String(model || '').trim();
  const cleanBackend = String(backend || '').trim();
  if (!cleanLabel || !cleanModel || !cleanBackend) {
    throw httpError(400, 'label, model, and backend are required');
  }
  if (cleanBackend === CLAUDE_BACKEND_ID || !isKnownBackend(cleanBackend)) {
    throw httpError(400, `backend '${cleanBackend}' is not a known custom-model backend — add it in Settings → Backends`);
  }
  const cw = Number(contextWindow);
  if (!Number.isFinite(cw) || cw <= 0) {
    throw httpError(400, 'contextWindow is required and must be a positive number of tokens');
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
export async function removeCustomModel(model: string): Promise<boolean> {
  const cur = loadSync();
  const existing = getCustomModels();
  const nextList = existing.filter(m => m.model !== model);
  if (nextList.length === existing.length) return false;
  const next = { ...cur, models: { ...(cur.models || {}), customModels: nextList } };
  await writeSettings(next);
  return true;
}

// True if a {backend, model} binding names a real, currently-available backend.
function isValidBinding(b: unknown): b is BackendBinding {
  if (!b || typeof b !== 'object') return false;
  const rec = b as { backend?: unknown; model?: unknown };
  if (rec.backend === CLAUDE_BACKEND_ID) return isKnownClaudeModel(rec.model);
  return isKnownBackendModel(rec.backend, rec.model);
}

// Reconstruct the persisted shape of a concrete binding. A binding is exactly
// {backend, model} — every model has one native context window, so there is
// nothing else to choose. Any extra key a caller sends (e.g. a stale `window`
// from an old client) is dropped here rather than persisted.
function persistBinding(b: BackendBinding): BackendBinding {
  return { backend: b.backend, model: b.model };
}

// Models group: tier → {backend, model} binding. `backend` is 'claude' (model =
// a MODEL_FAMILIES version id) or any other registry id (model = one of that
// backend's custom models / curated presets).
//
// IMPORTANT: a valid binding is returned verbatim (no silent revert); only an
// invalid/dead binding (unknown version, or a since-removed model or backend)
// falls back to the tier's default Claude backend.
export function getTierBackend(tier: TierName): BackendBinding {
  const s = loadSync();
  const stored = s.models?.tierBackend?.[tier];
  return isValidBinding(stored) ? stored : DEFAULT_TIER_BACKEND[tier];
}

export async function setTierBackend(tier: TierName, backend: unknown): Promise<Record<string, unknown>> {
  if (!isKnownTier(tier) || !isValidBinding(backend)) {
    throw httpError(400, 'tierBackend must be {backend, model} naming a known backend + model');
  }
  const cur = loadSync();
  const nextTierBackend: Record<string, unknown> = { ...(cur.models?.tierBackend || {}), [tier]: persistBinding(backend) };
  const next = { ...cur, models: { ...(cur.models || {}), tierBackend: nextTierBackend } };
  await writeSettings(next);
  return nextTierBackend;
}

// Roles group: role → binding. A binding is EITHER a tier binding
// ({kind:'tier', tier}) or a concrete {backend, model} pair (the same shape a
// tier binds to). The two are told apart by `kind === 'tier'`; a tier binding
// validates via isKnownTier, a concrete one via isValidBinding.
function isValidRoleBinding(b: unknown): b is BackendBinding | TierBinding {
  if (b && typeof b === 'object' && (b as { kind?: unknown }).kind === 'tier') {
    return isKnownTier((b as { tier?: unknown }).tier);
  }
  return isValidBinding(b);
}

// A role's fallback binding when nothing valid is stored. Built-in roles use
// their catalog default; a custom role (no catalog default) falls back to the
// current default spawn tier so it always resolves to a live backend.
function defaultRoleBinding(role: string): BackendBinding | TierBinding {
  return DEFAULT_ROLE_BINDING[role as RoleName] ?? { kind: 'tier', tier: getDefaultSpawnTier() };
}

// Role NAME matching is case-insensitive (a spawn caller may type `MyRole` for a
// role stored as `myrole`). Names are stored/displayed as the user typed them,
// but matched and deduped by lowercase. These helpers return the canonical
// STORED name (built-in or custom) for a case-insensitive lookup, or undefined.
function canonicalBuiltinRole(role: string): string | undefined {
  const lc = String(role).toLowerCase();
  return ROLES.find(r => r.role.toLowerCase() === lc)?.role;
}
function canonicalCustomRole(role: string): string | undefined {
  const lc = String(role).toLowerCase();
  return getCustomRoles().find(r => r.toLowerCase() === lc);
}
// The canonical STORED name for a plugin role (the exact '<plugin-id>/<slug>'
// id from the live provider), matched case-insensitively, or undefined. Used
// by setRoleBinding so a case-variant override targets the same roleBackend
// key as a canonical one (parity with the built-in/custom canonicalization
// above).
function canonicalPluginRole(role: string): string | undefined {
  const lc = String(role).toLowerCase();
  return getPluginRoles().find(r => r.role.toLowerCase() === lc)?.role;
}

// Stored role binding for a built-in or custom role (revert dead/invalid binding
// to the role default on read, like getTierBackend). A tier binding whose tier
// vanished, or a custom binding whose backend was removed, falls back to
// defaultRoleBinding(role). NOT for plugin roles — resolveRoleBackend handles
// those from the live provider binding.
export function getRoleBinding(role: string): BackendBinding | TierBinding {
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
export function effectiveRoleBinding(role: string): BackendBinding | TierBinding {
  const lc = String(role).toLowerCase();
  const pr = getPluginRoles().find(r => r.role.toLowerCase() === lc);
  if (pr) {
    const override = loadSync().models?.roleBackend?.[pr.role];
    return isValidRoleBinding(override) ? override : pr.binding;
  }
  const canonical = canonicalBuiltinRole(role) ?? canonicalCustomRole(role);
  return canonical ? getRoleBinding(canonical) : defaultRoleBinding(role);
}

export async function setRoleBinding(role: string, binding: BackendBinding | TierBinding): Promise<Record<string, unknown>> {
  // Canonicalize to the stored name so a case-variant rebind updates the same
  // roleBackend key rather than creating a duplicate. Plugin roles are included
  // — a user override of a plugin role's manifest binding is persisted under
  // its exact '<plugin-id>/<slug>' id and beats the manifest at resolve time.
  const canonical = canonicalBuiltinRole(role) ?? canonicalCustomRole(role) ?? canonicalPluginRole(role);
  if (!canonical || !isValidRoleBinding(binding)) {
    throw httpError(400, 'roleBackend must name a built-in, custom, or plugin role and be a known tier binding {kind:"tier",tier} or a {backend,model} pair');
  }
  const stored = 'kind' in binding
    ? { kind: 'tier', tier: binding.tier }
    : persistBinding(binding);
  const cur = loadSync();
  const nextRoleBackend: Record<string, unknown> = { ...(cur.models?.roleBackend || {}), [canonical]: stored };
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
export function resolveRoleBackend(role: string): BackendBinding {
  const b = effectiveRoleBinding(role);
  if ('kind' in b) return getTierBackend(b.tier);
  if (b.backend === CLAUDE_BACKEND_ID && !isKnownClaudeModel(b.model)) {
    return getTierBackend(getDefaultSpawnTier());
  }
  return persistBinding(b);
}

// ── Default effort ───────────────────────────────────────────────────────
// A SECOND axis on the same rows the bindings above live on: `models.tierEffort`
// ({tier: level}) and `models.roleEffort` ({role: 'inherit'|level}). It answers
// "how hard does a spawn on this tier/role think" — never "which model", which
// stays entirely with the bindings. Same read-time contract as the bindings: an
// invalid stored value reverts to the default on read, no migration-on-read.
//
// A ROLE stores `inherit` by default — follow the tier it is bound to — mirroring
// resolveRoleBackend's delegation of a tier reference to getTierBackend, so a role
// has one inheritance story for both axes. A tier has nothing to inherit from, so
// `inherit` is never a valid tier value.

export function getTierEffort(tier: TierName): EffortLevel {
  const s = loadSync();
  const stored = s.models?.tierEffort?.[tier];
  return isKnownEffort(stored) ? stored as EffortLevel : DEFAULT_EFFORT;
}

export async function setTierEffort(tier: TierName, effort: unknown): Promise<Record<string, unknown>> {
  if (!isKnownTier(tier) || !isKnownEffort(effort)) {
    throw httpError(400, `tierEffort must be a known capability tier and one of the effort levels (a tier has no '${INHERIT_EFFORT}')`);
  }
  const cur = loadSync();
  const nextTierEffort: Record<string, unknown> = { ...(cur.models?.tierEffort || {}), [tier]: effort };
  const next = { ...cur, models: { ...(cur.models || {}), tierEffort: nextTierEffort } };
  await writeSettings(next);
  return nextTierEffort;
}

// The role's STORED effort: an explicit level, or `inherit` (the default) meaning
// "follow the bound tier". Role names are canonicalized case-insensitively, like
// getRoleBinding's callers do, so `Conductor` and `conductor` read one key.
export function getRoleEffort(role: string): EffortLevel | 'inherit' {
  const canonical = canonicalBuiltinRole(role) ?? canonicalCustomRole(role) ?? canonicalPluginRole(role);
  if (canonical === undefined) return INHERIT_EFFORT;
  const s = loadSync();
  const stored = s.models?.roleEffort?.[canonical];
  return isKnownEffort(stored) ? stored as EffortLevel : INHERIT_EFFORT;
}

export async function setRoleEffort(role: string, effort: unknown): Promise<Record<string, unknown>> {
  const canonical = canonicalBuiltinRole(role) ?? canonicalCustomRole(role) ?? canonicalPluginRole(role);
  if (!canonical || !(effort === INHERIT_EFFORT || isKnownEffort(effort))) {
    throw httpError(400, `roleEffort must name a built-in, custom, or plugin role and be '${INHERIT_EFFORT}' or one of the effort levels`);
  }
  const cur = loadSync();
  const nextRoleEffort: Record<string, unknown> = { ...(cur.models?.roleEffort || {}), [canonical]: effort };
  const next = { ...cur, models: { ...(cur.models || {}), roleEffort: nextRoleEffort } };
  await writeSettings(next);
  return nextRoleEffort;
}

// What `inherit` resolves to for this role RIGHT NOW: the effort of the tier the
// role is bound to, or the global default when the role binds to a concrete
// backend+model (no tier to follow). Exported because the Settings payload ships
// it as the label of the role row's `Inherit (…)` option — the client renders that
// value, it never recomputes the chain.
export function inheritedRoleEffort(role: string): EffortLevel {
  const b = effectiveRoleBinding(role);
  return 'kind' in b ? getTierEffort(b.tier) : DEFAULT_EFFORT;
}

// The role's EFFECTIVE effort: an explicit level wins, `inherit` delegates.
export function resolveRoleEffort(role: string): EffortLevel {
  const stored = getRoleEffort(role);
  return isKnownEffort(stored) ? stored as EffortLevel : inheritedRoleEffort(role);
}

// THE resolution point for spawn effort — the whole precedence chain, in one
// place (what resolveBackendLaunch is for backend templates). Every spawn path
// routes through InstanceManager._doCreate, which calls exactly this.
//
//   1. an explicit `effort` from the caller (MCP spawn_instance, the spawn
//      dialog's Advanced options, the REST body) — validated HERE so an invalid
//      explicit value throws rather than silently decaying into a default;
//   2. the `role` the spawn resolved its model through, if any;
//   3. the `tier` the spawn resolved its model through, if any;
//   4. DEFAULT_EFFORT.
//
// Role before tier: the two are mutually exclusive in practice (a spawn resolves
// its model through one or the other — see mcp/handlers.ts spawnInstance), but
// the order is fixed so a caller that passes both gets the more specific one.
//
// An unknown tier/role name falls THROUGH to the next step rather than refusing.
// Unlike a missing backend (which would bill a real `claude` run against a foreign
// model id — see getTierBackend's callers) the only thing at stake here is which
// effort level a spawn runs at, so a refusal would be the harsher error.
//
// Paths with no tier/role at hand land on step 4 and keep today's behaviour: a
// resume recovers its model from the jsonl/sidecar, not from a binding, so there is
// no row to inherit an effort from. That is the sidebar one-click resume, the anchor
// auto-resume, and spawn_instance({resume}). Two other relaunch paths never reach
// step 4 at all: the restart manifest passes the recorded `effort` explicitly (step
// 1, so a session returns at the level it was running at), and Instance.launch({resume})
// — respawn_instance, crash-respawn, rewind, prune — reuses the live `this.effort`
// without re-entering _doCreate. Table of all of them: docs/models.md#default-effort.
export function resolveSpawnEffort(input: { effort?: unknown; tier?: unknown; role?: unknown } = {}): EffortLevel {
  const { effort, tier, role } = input;
  // Only `undefined`/`null` mean "the caller didn't ask" (an absent JSON field, an
  // omitted MCP arg). Anything else present — including the empty string — is an
  // ATTEMPT to name a level and must be validated, not absorbed: `''` was a 400
  // before this feature and staying a 400 is what keeps "an invalid explicit value
  // never silently becomes a default" true. (The spawn dialog's `Default` option
  // has value '' but is normalized to `undefined` before the POST — see
  // public/spawnDialog.js.)
  if (effort !== undefined && effort !== null) {
    if (!isKnownEffort(effort)) {
      throw httpError(400, 'invalid effort');
    }
    return effort as EffortLevel;
  }
  if (typeof role === 'string' && role && isResolvableRole(role)) return resolveRoleEffort(role);
  if (typeof tier === 'string' && tier && isKnownTier(tier)) return getTierEffort(tier as TierName);
  return DEFAULT_EFFORT;
}

// ── Custom + plugin roles ────────────────────────────────────────────────
// Plugin-owned roles are LIVE-DERIVED from enabled plugins (never persisted),
// mirroring plugin conventions: the provider is injected by server.js
// (`setPluginRolesProvider(() => pluginHost.roles())`) so this low-level store
// never imports the plugin registry. Each entry: {role:'<plugin-id>/<slug>',
// label, binding:{kind:'tier',tier}|{backend,model}, plugin:id}. Default [] keeps
// tests / headless runs (no plugin host) working, and disabling a plugin drops
// its roles automatically (the provider derives from enabled plugins).
interface PluginRoleRecord {
  role: string;
  label: string;
  binding: BackendBinding | TierBinding;
  plugin: string;
}
let pluginRolesProvider: () => PluginRoleRecord[] = () => [];
export function setPluginRolesProvider(fn: (() => PluginRoleRecord[]) | null | undefined): void {
  pluginRolesProvider = typeof fn === 'function' ? fn : (() => []);
}
export function getPluginRoles(): PluginRoleRecord[] {
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
// distinct from the lowercase plugin-slug rule (manifest.ts) — a custom role name
// is a user-facing, case-preserving label, not a lowercase identifier slug.
const CUSTOM_ROLE_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const CUSTOM_ROLE_MAX = 40;

export function getCustomRoles(): string[] {
  const s = loadSync();
  const list = s.models?.customRoles;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const r of list) {
    if (typeof r === 'string' && r) out.push(r);
  }
  return out;
}

interface RoleSummary {
  role: string;
  label?: string;
  builtin?: boolean;
  plugin?: string;
}

// The full live role catalog: built-in + user custom + plugin-owned. Built-in and
// plugin entries carry a display `label`; a custom entry is name-only ({role}).
// Single source for the Settings payload and the resolution guard.
export function getAllRoles(): RoleSummary[] {
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
export function isResolvableRole(role: unknown): boolean {
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
export async function addCustomRole(input: { role?: unknown; binding?: unknown } = {}): Promise<{ role: string }> {
  const { role, binding } = input;
  const name = String(role || '').trim();
  if (!CUSTOM_ROLE_RE.test(name) || name.length > CUSTOM_ROLE_MAX) {
    throw httpError(400, 'role must match ^[A-Za-z][A-Za-z0-9-]*$ (max 40 chars)');
  }
  const lc = name.toLowerCase();
  if (isKnownTier(lc) || isKnownRole(lc) || isKnownFamily(lc)) {
    throw httpError(400, `name '${name}' collides with a built-in tier, role, or model family`);
  }
  if (getCustomRoles().some(r => r.toLowerCase() === lc)) {
    throw httpError(409, `role '${name}' already exists`);
  }
  const b = binding ?? { kind: 'tier', tier: 'powerful' };
  if (!isValidRoleBinding(b)) {
    throw httpError(400, 'binding must be a known tier binding {kind:"tier",tier} or a {backend,model} pair');
  }
  const stored = 'kind' in b ? { kind: 'tier', tier: b.tier } : persistBinding(b);
  const cur = loadSync();
  const models = {
    ...(cur.models || {}),
    customRoles: [...getCustomRoles(), name],
    roleBackend: { ...(cur.models?.roleBackend || {}), [name]: stored },
  };
  await writeSettings({ ...cur, models });
  return { role: name };
}

// Remove a custom role and BOTH of its axes — binding and default effort
// (case-insensitive). Returns false if no matching custom role. Leaving either
// behind would silently re-apply to a later role of the same name: recreating
// `Tester` starts on the default tier at `inherit`, so a stranded roleEffort
// entry would spawn it at an effort nothing in the UI attributes to it.
export async function removeCustomRole(role: string): Promise<boolean> {
  const canonical = canonicalCustomRole(role);
  if (canonical === undefined) return false;
  const cur = loadSync();
  const nextList = getCustomRoles().filter(r => r !== canonical);
  const roleBackend: Record<string, unknown> = { ...(cur.models?.roleBackend || {}) };
  delete roleBackend[canonical];
  const models: Record<string, unknown> = { ...(cur.models || {}), customRoles: nextList, roleBackend };
  // Guarded rather than unconditional: a store with no roleEffort key has nothing
  // to strip, and materializing an empty map would write a setting the user never
  // touched (the same principle migration 0025 states for a missing `models`).
  if (cur.models?.roleEffort) {
    const roleEffort = { ...cur.models.roleEffort };
    delete roleEffort[canonical];
    models.roleEffort = roleEffort;
  }
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

function snapCompactK(k: number): number {
  const snapped = Math.round(k / COMPACT_K_STEP) * COMPACT_K_STEP;
  return Math.max(COMPACT_K_MIN, Math.min(COMPACT_K_MAX, snapped));
}

export function getConductorCompactWindow(): { enabled: boolean; value: number } {
  const s = loadSync();
  const envRaw    = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const envTokens = envRaw ? parseInt(envRaw, 10) : null;
  const envK      = (envTokens !== null && Number.isFinite(envTokens) && envTokens > 0)
    ? snapCompactK(Math.round(envTokens / 1000))
    : null;
  const storedEnabled = s.models?.conductorCompactWindowEnabled;
  const storedK = s.models?.conductorCompactWindowK;
  return {
    enabled: typeof storedEnabled === 'boolean' ? storedEnabled : (envK !== null),
    value: typeof storedK === 'number' && Number.isFinite(storedK) ? storedK : envK ?? COMPACT_K_DEFAULT,
  };
}

export async function setConductorCompactWindow(input: { enabled: unknown; value: unknown }): Promise<{ enabled: boolean; value: number }> {
  const { enabled, value } = input;
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

function snapOveragePct(p: number): number {
  return Math.max(OVERAGE_PCT_MIN, Math.min(OVERAGE_PCT_MAX, Math.round(p)));
}

export function getOverageThreshold(): { enabled: boolean; value: number } {
  const s = loadSync();
  const storedEnabled = s.models?.overageThresholdEnabled;
  const storedPct = s.models?.overageThresholdPct;
  return {
    enabled: typeof storedEnabled === 'boolean' ? storedEnabled : false,
    value: typeof storedPct === 'number' && Number.isFinite(storedPct) ? storedPct : OVERAGE_PCT_DEFAULT,
  };
}

// Single source of truth for "is the account still over the overage bar?", given
// an account-usage payload (src/accountUsage.ts shape: five_hour.utilization is a
// 0–100 PERCENT). Used by BOTH the server-side poll trip (usageOverageMonitor) and
// the usage-verified auto-resume (overageResume) so the trip and the resume never
// disagree. Returns:
//   true  — still over: the five-hour window is fully consumed (utilization >= 100,
//           the usage-payload proxy for the stream-only `isUsingOverage` hard flag,
//           checked even when the optional threshold is off), OR the configured
//           threshold is enabled and its percent is still crossed.
//   false — clear: window has reset / dropped below the bar.
//   null  — can't tell: payload missing/malformed (caller treats like a failed fetch).
export function usageOverThreshold(usage: { five_hour?: { utilization?: unknown } } | null | undefined): boolean | null {
  const win = usage?.five_hour;
  if (!win || typeof win.utilization !== 'number') return null;
  if (win.utilization >= 100) return true; // hard-overage proxy (window not reset)
  const t = getOverageThreshold();
  if (t.enabled && win.utilization >= t.value) return true;
  return false;
}

export async function setOverageThreshold(input: { enabled: unknown; value: unknown }): Promise<{ enabled: boolean; value: number }> {
  const { enabled, value } = input;
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

// Throw an Error carrying an HTTP statusCode for the REST layer, using the
// same Object.assign pattern the routes consume (`err.statusCode`). Typed as
// `Error & { statusCode: number }` so callers can rely on the code without a
// cast.
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
