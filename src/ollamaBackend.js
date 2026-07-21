// Reachability + model-availability preflight for Ollama-backed models. Pure
// HTTP against the local Ollama server's REST API (localhost only — the app is
// single-user/local), so the Settings add-form fails fast with a clear message
// instead of spawning into a silent `ollama launch` failure.
//
// Endpoints: GET /api/version (liveness) and GET /api/tags (locally available
// models). Cloud tags (e.g. `foo:cloud`, `foo:120b-cloud`) are account-served
// and may NOT appear in /api/tags, so model-availability is lenient for any
// tag whose last `:`-segment is (or ends with) `cloud` — reachability is the
// hard gate.

export const OLLAMA_BASE = 'http://localhost:11434';

async function getJson(url, timeoutMs = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

// Liveness: resolves { ok, version } or { ok:false, error }.
export async function checkOllamaReachable() {
  const r = await getJson(`${OLLAMA_BASE}/api/version`);
  if (!r.ok) return { ok: false, error: `Ollama not reachable at ${OLLAMA_BASE} (${r.error})` };
  return { ok: true, version: r.body?.version ?? null };
}

// Model availability. Returns { ok:true, available } when reachable (available
// reflects whether the tag is present, `:cloud` treated leniently), or
// { ok:false, error } when unreachable.
export async function checkModelAvailable(tag) {
  const r = await getJson(`${OLLAMA_BASE}/api/tags`);
  if (!r.ok) return { ok: false, error: `Ollama not reachable at ${OLLAMA_BASE} (${r.error})` };
  const models = Array.isArray(r.body?.models) ? r.body.models : [];
  const names = models.map(m => m?.name).filter(Boolean);
  const wanted = String(tag || '').trim();
  const present = names.includes(wanted)
    || names.includes(`${wanted}:latest`)
    || (wanted.endsWith(':latest') && names.includes(wanted.slice(0, -':latest'.length)));
  // Cloud tags are account-served and may be absent from /api/tags — treat
  // any tag whose LAST `:`-segment is `cloud` or ends `-cloud` (e.g. plain
  // `:cloud`, or size-pinned `:675b-cloud`) as leniently available. Checking
  // only the last segment (not a bare substring match) avoids misclassifying
  // a hypothetical local tag that merely contains "cloud" elsewhere.
  const lastSegment = wanted.includes(':') ? wanted.slice(wanted.lastIndexOf(':') + 1) : '';
  const isCloudTag = lastSegment === 'cloud' || lastSegment.endsWith('-cloud');
  const available = present || isCloudTag;
  return { ok: true, available, models: names };
}

// Combined preflight before add/spawn: reachable AND model present (leniently).
export async function preflightOllamaBackend({ model } = {}) {
  const live = await checkOllamaReachable();
  if (!live.ok) return live;
  const avail = await checkModelAvailable(model);
  if (!avail.ok) return avail;
  if (!avail.available) {
    return { ok: false, error: `Model "${model}" not found on Ollama at ${OLLAMA_BASE} — pull it first (ollama pull ${model})` };
  }
  return { ok: true };
}

// Single shared error shape for every preflightOllamaBackend() failure site
// (Instance spawn/respawn, bundle-gen, summary-gen) — REST surfaces it as a
// 503, MCP surfaces it as an isError result carrying the same prose. `prefix`
// lets a caller match its own module's error-message convention (e.g.
// claudeShellEnv.js's "claudeShellEnv: ..." style) without forking the shape.
export function ollamaPreflightError(pre, prefix) {
  const message = prefix ? `${prefix}: ${pre.error}` : pre.error;
  return Object.assign(new Error(message), { statusCode: 503, code: 'OLLAMA_PREFLIGHT_FAILED' });
}
