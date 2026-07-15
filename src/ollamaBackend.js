// Reachability + model-availability preflight for Ollama-backed custom
// backends. Pure HTTP against the Ollama server's REST API (works for a remote
// host too), so the Settings add-form and the spawn path can fail fast with a
// clear message instead of spawning into a silent `ollama launch` hang.
//
// Ollama's endpoints: GET /api/version (liveness) and GET /api/tags (locally
// available models). Cloud tags (e.g. `foo:cloud`) are served through the
// account and may NOT appear in /api/tags, so model-availability is lenient
// for `:cloud` tags — reachability is the hard gate.

export const DEFAULT_OLLAMA_HOST = 'localhost:11434';

// Normalize a host (`host:port`, or a full URL) into a base URL. Empty ⇒ the
// default localhost host.
export function ollamaBaseUrl(host) {
  const h = (typeof host === 'string' && host.trim()) ? host.trim() : DEFAULT_OLLAMA_HOST;
  if (/^https?:\/\//i.test(h)) return h.replace(/\/+$/, '');
  return `http://${h.replace(/\/+$/, '')}`;
}

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
export async function checkOllamaReachable(host) {
  const base = ollamaBaseUrl(host);
  const r = await getJson(`${base}/api/version`);
  if (!r.ok) return { ok: false, error: `Ollama not reachable at ${base} (${r.error})` };
  return { ok: true, version: r.body?.version ?? null };
}

// Model availability. Returns { ok:true, available:bool } when the server is
// reachable (available reflects whether the tag is present, with `:cloud` tags
// treated leniently), or { ok:false, error } when the server is unreachable.
export async function checkModelAvailable(host, tag) {
  const base = ollamaBaseUrl(host);
  const r = await getJson(`${base}/api/tags`);
  if (!r.ok) return { ok: false, error: `Ollama not reachable at ${base} (${r.error})` };
  const models = Array.isArray(r.body?.models) ? r.body.models : [];
  const names = models.map(m => m?.name).filter(Boolean);
  const wanted = String(tag || '').trim();
  // Ollama lists a bare `foo` as `foo:latest`; accept either form.
  const present = names.includes(wanted)
    || names.includes(`${wanted}:latest`)
    || (wanted.endsWith(':latest') && names.includes(wanted.slice(0, -':latest'.length)));
  // Cloud tags are account-served and usually absent from /api/tags — don't
  // hard-fail on them once the server itself is reachable.
  const available = present || wanted.endsWith(':cloud');
  return { ok: true, available, models: names };
}

// Combined preflight used before binding/spawning: reachable AND model present
// (leniently). Resolves { ok:true } or { ok:false, error }.
export async function preflightOllamaBackend({ host, model } = {}) {
  const live = await checkOllamaReachable(host);
  if (!live.ok) return live;
  const avail = await checkModelAvailable(host, model);
  if (!avail.ok) return avail;
  if (!avail.available) {
    return { ok: false, error: `Model "${model}" not found on Ollama at ${ollamaBaseUrl(host)} — pull it first (ollama pull ${model})` };
  }
  return { ok: true };
}
