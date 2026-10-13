// Client-side DISPLAY cache for the model catalog (Settings → Models). The
// spawn dialog, the Conduct button and the live "Change model" popover each
// send only a `tier` or `role` name — never a resolved {model, backend} — and
// the server resolves that name against the CURRENT stored binding at the
// moment it acts. This module's job is limited to rendering: tier sublabels,
// the Change-model highlight, the disabled pre-block, and the effort
// `Default (…)` label. Catalog fetched once at boot, refreshed on Settings
// changes.
//
// This module holds NO context-window policy. Every model has exactly one
// native capacity, resolved server-side from {backend, model} and delivered as
// the instance summary's `contextWindowTokens`; the launch tag some Claude
// builds need is applied server-side too (canonicalizeModel). A client mirror
// of either would be a second source of truth that drifts.

// A tier's {backend, model} binding; a missing backend is Claude (backendIdOf).
export type Binding = { backend?: string; model: string };
// A backend registry row.
export type Backend = { id: string; label: string; managed?: boolean };
// A substitution backend's registered model.
export type BackendModel = { model: string; label: string };

// The fields of the models payload (GET /api/settings/models) this cache reads.
export type ModelsCatalog = {
  claudeFamilies?: { versions?: { id: string; label: string }[] }[];
  tiers?: { tier: string; label: string }[];
  backends?: Backend[];
  backendModels?: Record<string, BackendModel[]>;
  tierBackend?: Record<string, Binding>;
  defaultEffort?: string;
  efforts?: string[];
  tierEffort?: Record<string, string>;
  enabledTiers?: Record<string, boolean>;
  defaultSpawnTier?: string;
};

// Pre-fetch fallback version ids (one per family) — only used to seed the
// default tier bindings before the boot fetch resolves.
const DEFAULT_VERSIONS = {
  fable: 'claude-fable-5-1',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5',
};

// Friendly names for the pre-fetch fallback ids above — overwritten by the
// shipped catalog's per-version `label` field once loadModelVersions() resolves.
const DEFAULT_VERSION_LABELS: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
};

// The identity backend id (mirrors CLAUDE_BACKEND_ID in src/modelVersions.ts).
export const CLAUDE_BACKEND = 'claude';

// Pre-fetch fallback tier→{backend,model} bindings (mirrors DEFAULT_TIER_BACKEND
// in src/modelVersions.ts). Overwritten by the shipped catalog at boot.
const DEFAULT_TIER_BACKEND: Record<string, Binding> = {
  fast:     { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.haiku },
  balanced: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.sonnet },
  powerful: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.opus },
  frontier: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.fable },
};
const DEFAULT_TIER_LABELS: Record<string, string> = { fast: 'Fast', balanced: 'Balanced', powerful: 'Powerful', frontier: 'Frontier' };

// First-paint seed for the end of the effort chain (mirrors DEFAULT_EFFORT in
// src/effortLevels.ts) — replaced by the payload's `defaultEffort` on the boot
// fetch, so the shipped value is the single source and this is only what a
// pre-fetch read sees. Read for DISPLAY only: the spawn dialog's `Default (…)`
// label. The client never resolves the effort chain itself (that is
// resolveSpawnEffort, src/appSettings.ts).
let defaultEffort = 'high';

// First-paint seed for the effort VOCABULARY (mirrors EFFORT_LEVELS in
// src/effortLevels.ts, ordered low → high) — replaced by the payload's `efforts`
// on the boot fetch. Rendered verbatim by the ⋮ menu's Change-effort picker.
let effortLevels: string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

let activeTierEffort: Record<string, string> = {};
let activeTierEnabled: Record<string, boolean> = { fast: true, balanced: true, powerful: true, frontier: true };
let activeDefaultSpawnTier = 'powerful';
let activeTierBackend: Record<string, Binding> = { ...DEFAULT_TIER_BACKEND };
let claudeVersionLabelById: Record<string, string> = {};
let tierList = Object.keys(DEFAULT_TIER_BACKEND);
let tierLabels = { ...DEFAULT_TIER_LABELS };
// First-paint fallback of the backend REGISTRY — the two managed rows. A
// fallback only; the server's registry (which also carries user rows) replaces it
// on the boot fetch.
let backends: Backend[] = [{ id: CLAUDE_BACKEND, label: 'Claude', managed: true }, { id: 'ollama', label: 'Ollama', managed: true }];
// Each substitution backend's registered models ({model, label}), keyed by
// backend id, as shipped by the server (backendModels in src/appSettings.ts).
// Empty until the boot fetch: no list means nothing is offered yet.
let backendModels: Record<string, BackendModel[]> = {};

export function getTierList(): string[] { return tierList; }
export function getTierLabel(tier: string): string { return tierLabels[tier] || tier; }
export function setBackends(list: Backend[] | null | undefined): Backend[] { backends = Array.isArray(list) && list.length ? list : backends; return backends; }
export function getBackends(): Backend[] { return backends; }
export function getBackendLabel(id: string): string { return backends.find(b => b.id === id)?.label || id; }
export function getBackendModels(id: string): BackendModel[] { return backendModels[id] || []; }
export function setBackendModels(map: Record<string, BackendModel[]> | null | undefined): void { backendModels = { ...(map || {}) }; }

// Infer the Claude family from a model id, by prefix. Mirrors familyOf() in
// src/modelVersions.ts. A naming heuristic for grouping the Settings picker —
// never a backend test; only a binding's `backend` field says which registry row
// serves a model.
export function familyOf(modelId: unknown): 'fable' | 'opus' | 'sonnet' | 'haiku' | null {
  if (typeof modelId !== 'string') return null;
  if (modelId.startsWith('claude-fable')) return 'fable';
  if (modelId.startsWith('claude-opus')) return 'opus';
  if (modelId.startsWith('claude-sonnet')) return 'sonnet';
  if (modelId.startsWith('claude-haiku')) return 'haiku';
  return null;
}

// Backend id of a {backend, model} tier binding.
export function backendIdOf(binding: { backend?: unknown } | null | undefined): string {
  return (binding && typeof binding.backend === 'string' && binding.backend) || CLAUDE_BACKEND;
}

// Friendly display name for a Claude version id (e.g. "Opus 4.8"), falling
// back to the pre-fetch default label, then the raw id itself.
export function getVersionLabel(id: string): string { return claudeVersionLabelById[id] || DEFAULT_VERSION_LABELS[id] || id; }

export function getActiveTierEnabled(tier: string): boolean { return activeTierEnabled[tier] !== false; }
export function setActiveTierEnabled(map: Record<string, boolean> | null | undefined): void { activeTierEnabled = { ...activeTierEnabled, ...(map || {}) }; }
export function getActiveDefaultSpawnTier(): string { return activeDefaultSpawnTier; }
export function setActiveDefaultSpawnTier(v: string | null | undefined): string { activeDefaultSpawnTier = v || 'powerful'; return activeDefaultSpawnTier; }

// Returns the tier's {backend, model} binding (fallback default if unset).
export function getActiveTierBackend(tier: string): Binding { return activeTierBackend[tier] || DEFAULT_TIER_BACKEND[tier]; }
export function setActiveTierBackend(map: Record<string, Binding> | null | undefined): void { activeTierBackend = { ...activeTierBackend, ...(map || {}) }; }

// The effort a spawn on this tier runs at, as resolved SERVER-side and shipped in
// the models payload. Display-only.
export function getActiveTierEffort(tier: string): string { return activeTierEffort[tier] || defaultEffort; }
export function setActiveTierEffort(map: Record<string, string> | null | undefined): void { activeTierEffort = { ...activeTierEffort, ...(map || {}) }; }
export function setDefaultEffort(level: string | null | undefined): string { if (level) defaultEffort = level; return defaultEffort; }

// The level catalog, as shipped by the server. Ordered — the picker renders it
// in array order.
export function getEffortLevels(): string[] { return effortLevels; }
export function setEffortLevels(list: string[] | null | undefined): string[] { if (Array.isArray(list) && list.length) effortLevels = [...list]; return effortLevels; }

// Applies a models payload (`GET /api/settings/models`, or the refreshed state
// every Settings → Models mutation returns) to this cache. The boot fetch and
// the Settings `onModelsChange` handler both go through it, so a Settings edit
// refreshes everything the boot fetch seeded.
export function applyModelsPayload(data: ModelsCatalog): void {
  if (Array.isArray(data.claudeFamilies) && data.claudeFamilies.length) {
    claudeVersionLabelById = Object.fromEntries(
      data.claudeFamilies.flatMap(b => b.versions || []).map(v => [v.id, v.label]),
    );
  }
  if (Array.isArray(data.tiers) && data.tiers.length) {
    tierList = data.tiers.map(t => t.tier);
    tierLabels = Object.fromEntries(data.tiers.map(t => [t.tier, t.label]));
  }
  setBackends(data.backends);
  if (data.backendModels) setBackendModels(data.backendModels);
  if (data.tierBackend) setActiveTierBackend(data.tierBackend);
  setDefaultEffort(data.defaultEffort);
  setEffortLevels(data.efforts);
  if (data.tierEffort) setActiveTierEffort(data.tierEffort);
  if (data.enabledTiers) setActiveTierEnabled(data.enabledTiers);
  setActiveDefaultSpawnTier(data.defaultSpawnTier);
}

export async function loadModelVersions(): Promise<Record<string, Binding>> {
  try {
    const r = await fetch('/api/settings/models', { cache: 'no-store' });
    if (r.ok) applyModelsPayload(await r.json());
  } catch { /* keep defaults */ }
  return activeTierBackend;
}
