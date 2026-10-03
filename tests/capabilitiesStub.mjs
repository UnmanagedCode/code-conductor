// A fetch wrapper for happy-dom tests of modules that read the platform's
// capabilities (public/capabilities.js): answers GET /api/health with the given
// flags (all on by default) and passes every other request to `inner`.

export const ALL_ON = { remoteSystems: true, fuseUnion: true, voice: true };

export function withHealth(inner, capabilities = ALL_ON) {
  return (url, opts) => {
    if (String(url).includes('/api/health')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, capabilities }) });
    }
    return inner(url, opts);
  };
}
