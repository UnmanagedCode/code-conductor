// Curated catalog of Ollama *cloud* coding models, offered as selectable
// presets in the Settings → Models Ollama picker alongside the user's own
// `customBackends`. Unlike customBackends these are read-only and never
// persisted — this module is the single source of truth, shipped to the
// client via `GET /api/settings/models` (see routes.js modelsSettingsState).
//
// Tags are verbatim from ollama.com and deliberately inconsistent: most use
// the bare `:cloud` alias, but Mistral Large 3 has no bare alias and stays
// size-pinned (`:675b-cloud`) — do not "normalize" it.
export const OLLAMA_CLOUD_MODELS = [
  { model: 'deepseek-v4-flash:cloud',    label: 'DeepSeek V4 Flash (fast MoE)' },
  { model: 'qwen3.5:cloud',              label: 'Qwen3.5 (flagship coder)' },
  { model: 'glm-5.2:cloud',              label: 'GLM-5.2 (SWE-bench leader)' },
  { model: 'deepseek-v4-pro:cloud',      label: 'DeepSeek V4 Pro (frontier, 1M ctx)' },
  { model: 'kimi-k2.7-code:cloud',       label: 'Kimi K2.7 Code' },
  { model: 'minimax-m3:cloud',           label: 'MiniMax M3 (1M ctx)' },
  { model: 'mistral-large-3:675b-cloud', label: 'Mistral Large 3' },
];

// Per-tier catalog default, used only as the auto-picked model when a user
// switches THAT tier's Settings → Models provider to Ollama (see
// onPickBackendKind in public/settings.js). Does not change the global
// out-of-the-box tier default (DEFAULT_TIER_BACKEND in modelVersions.js
// stays all-Claude) — frontier intentionally has no catalog default.
export const OLLAMA_CLOUD_TIER_DEFAULTS = {
  fast: 'deepseek-v4-flash:cloud',
  balanced: 'qwen3.5:cloud',
  powerful: 'glm-5.2:cloud',
};

export function isKnownOllamaCloudModel(tag) {
  return OLLAMA_CLOUD_MODELS.some(m => m.model === tag);
}
