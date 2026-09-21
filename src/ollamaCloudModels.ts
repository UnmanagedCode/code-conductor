// Curated catalog of Ollama *cloud* coding models, offered as selectable
// presets alongside the user's own `customModels` — scoped to the BUILT-IN
// `ollama` backend only (a user-defined backend gets no curated catalog; see
// isKnownBackendModel in appSettings.ts). Unlike customModels these are
// read-only and never persisted — this module is the single source of truth,
// shipped to the client via `GET /api/settings/models` (see routes.ts
// modelsSettingsState).
//
// Tags are verbatim from ollama.com and deliberately not normalized: a row
// carries whatever id that site serves, including a size-pinned
// `<name>:<size>-cloud` form — do not rewrite it into a bare `:cloud` alias.
//
// `contextWindow` is the model's native window in raw tokens (round decimals).
// This is the authoritative per-model size: resolveContextWindowTokens() in
// src/appSettings.ts reads it (via contextWindowForModel) to produce the
// session's `contextWindowTokens`, which drives the header context-usage bar and
// both CLAUDE_CODE_AUTO_COMPACT_WINDOW and CLAUDE_CODE_MAX_CONTEXT_TOKENS at
// spawn time. The client holds no capacity table of its own. A row whose window
// has a lower guaranteed minimum and a higher billed ceiling advertises the
// ceiling.

// `midTurnSteering` is an OPT-OUT capability flag: absent/true means the model
// accepts a user message written INTO a running turn, `false` means it does not
// (it either hard-errors or silently swallows the injection). Read through
// resolveMidTurnSteering() in src/appSettings.ts, which a custom-model row of the
// same id overrides. See docs/models.md.
export interface OllamaCloudModel {
  model: string;
  label: string;
  contextWindow: number;
  midTurnSteering?: boolean;
}

export const OLLAMA_CLOUD_MODELS: readonly OllamaCloudModel[] = [
  { model: 'deepseek-v4.1-flash:cloud',  label: 'DeepSeek V4.1 Flash',      contextWindow: 1_000_000 },
  { model: 'glm-5.3:cloud',              label: 'GLM-5.3',                  contextWindow: 1_000_000 },
  { model: 'glm-5.3-flash:cloud',        label: 'GLM-5.3 Flash',            contextWindow: 1_000_000 },
  { model: 'kimi-k3:cloud',              label: 'Kimi K3',                  contextWindow: 1_000_000 },
];

// Per-tier catalog default, used only as the auto-picked model when a user
// switches THAT tier's Settings → Models backend to the built-in `ollama` row
// (see onPickBackend in public/settings.js). Does not change the global
// out-of-the-box tier default (DEFAULT_TIER_BACKEND in modelVersions.ts
// stays all-Claude) — frontier intentionally has no catalog default.
export const OLLAMA_CLOUD_TIER_DEFAULTS: Record<string, string> = {
  fast: 'deepseek-v4.1-flash:cloud',
  balanced: 'deepseek-v4.1-flash:cloud',
  powerful: 'deepseek-v4.1-flash:cloud',
};

export function isKnownOllamaCloudModel(tag: unknown): boolean {
  return OLLAMA_CLOUD_MODELS.some(m => m.model === tag);
}
