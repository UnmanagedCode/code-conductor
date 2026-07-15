// Reachability + model-availability preflight for Ollama-backed models. Pure
// HTTP against the local Ollama server's REST API (localhost only — the app is
// single-user/local), so the Settings add-form fails fast with a clear message
// instead of spawning into a silent `ollama launch` failure.
//
// Endpoints: GET /api/version (liveness) and GET /api/tags (locally available
// models). Cloud tags (e.g. `foo:cloud`) are account-served and may NOT appear
// in /api/tags, so model-availability is lenient for `:cloud` tags —
// reachability is the hard gate.

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
  const available = present || wanted.endsWith(':cloud');
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
