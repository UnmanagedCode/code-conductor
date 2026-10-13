// Pure helpers behind Settings → Models / Backends, over the /api/settings/models payload.
import { CLAUDE_BACKEND, backendIdOf } from '@shared/models';

export type Binding = { backend?: string; model: string; kind?: string; tier?: string };
export type ModelsPayload = {
  tiers?: { tier: string; label: string }[];
  backends?: { id: string; label: string; template?: string; env?: { key: string; value: string }[]; managed?: boolean }[];
  claudeFamilies?: { family: string; label: string; default?: string; versions: { id: string; label: string; contextWindow?: number }[] }[];
  customModels?: { label: string; model: string; backend: string; contextWindow: number; midTurnSteering?: boolean }[];
  ollamaCloudModels?: { model: string; label: string; contextWindow?: number }[];
  ollamaCloudTierDefaults?: Record<string, string>;
  tierBackend?: Record<string, Binding>;
  tierEffort?: Record<string, string>;
  efforts?: string[];
  defaultEffort?: string;
  enabledTiers?: Record<string, boolean>;
  defaultSpawnTier?: string;
  roles?: { role: string; label?: string; builtin?: boolean; plugin?: string }[];
  roleBackend?: Record<string, Binding>;
  roleEffort?: Record<string, { effort?: string; inheritsTo?: string }>;
  onOverage?: 'none' | 'stop' | 'stop-resume';
  overageThreshold?: { enabled: boolean; value: number };
  conductorCompactWindow?: { enabled: boolean; value: number };
  [k: string]: unknown;
};

export { CLAUDE_BACKEND, backendIdOf };

export const backendIdFor = (b: Binding | undefined): string => backendIdOf(b);

export function claudeVersions(data: ModelsPayload) {
  return (data.claudeFamilies || []).flatMap((f) => f.versions.map((v) => ({ ...v, family: f.family })));
}

export function backendLabel(data: ModelsPayload, id: string) {
  return (data.backends || []).find((b) => b.id === id)?.label || id;
}

/** The models a tier/role can pick on a substitution backend: the ollama curated catalog, then the user's own. */
export function modelsForBackend(data: ModelsPayload, id: string) {
  return {
    curated: id === 'ollama' ? data.ollamaCloudModels || [] : [],
    custom: (data.customModels || []).filter((m) => m.backend === id),
  };
}

/** "Fable 5.1", or "Ollama — glm-5.3:cloud" for a substitution backend. */
export function describeBinding(data: ModelsPayload, b: Binding) {
  const id = backendIdOf(b);
  if (id !== CLAUDE_BACKEND) return `${backendLabel(data, id)} — ${b.model}`;
  return claudeVersions(data).find((v) => v.id === b.model)?.label || b.model;
}

/** Sonnet's default (else the first family's) — where a switch back to Claude lands. */
export function defaultClaudeModel(data: ModelsPayload): string | undefined {
  const families = data.claudeFamilies || [];
  const sonnet = families.find((f) => f.family === 'sonnet') || families[0];
  return sonnet?.default || families[0]?.versions?.[0]?.id;
}

/**
 * The model a tier/role lands on when switched to `backend`: the tier's curated
 * ollama default, else the user's first model there, else the first curated one.
 * null = nothing bindable (the switch is refused).
 */
export function firstModelForBackend(data: ModelsPayload, backend: string, tier: string | null) {
  const curated = backend === 'ollama' ? data.ollamaCloudModels || [] : [];
  if (tier) {
    const preset = curated.find((c) => c.model === (data.ollamaCloudTierDefaults || {})[tier]);
    if (preset) return preset;
  }
  const custom = (data.customModels || []).filter((m) => m.backend === backend);
  return custom[0] || curated[0] || null;
}

/** "200000", "200k", "1m", "1.5m" → tokens; anything else (or ≤ 0) → null. */
export function parseCtxTokens(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^(\d*\.?\d+)\s*([km])$/i.exec(s);
  const n = m ? Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

export function fmtCtxTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

export function envToText(env: { key: string; value: string }[] | undefined) {
  return (Array.isArray(env) ? env : []).map((e) => `${e.key}=${e.value}`).join('\n');
}

/** One KEY=VALUE per line; blank lines dropped; a line without "=" is a key with an empty value. */
export function envFromText(text: string) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return i === -1 ? { key: l, value: '' } : { key: l.slice(0, i).trim(), value: l.slice(i + 1) };
  });
}

/** The provider command field → argv; empty clears it (null), never an empty argv. */
export function launchFromText(text: string): string[] | null {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts : null;
}
