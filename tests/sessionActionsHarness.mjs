// Shared harness for tests that drive the real `installSessionActions` against
// a scripted fetch (no `.test.mjs` suffix: tests/run.mjs must not run it).
//
// sessionActions.js has no import-time browser deps (see anchor-autoresume), so
// it loads here directly; only `fetch`/`alert`/`confirm` are stubbed. Every
// request, alert and confirm is recorded so "nothing was sent" is an assertion
// rather than an absence of visible effect.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

export const ID = 'inst-1';

// `bodies` answers by URL suffix: `sync`, `rebasePrompt`, `merge`.
// `refreshProjectsError`: when set, `refreshProjects()` rejects with it.
export async function setupSessionActions({
  activeId = ID, instances = [], bodies = {}, confirmAnswer = true, refreshProjectsError = null,
} = {}) {
  const { installSessionActions } = await load('sessionActions.js');
  const calls = [];
  const alerts = [];
  const confirms = [];
  const refreshes = { projects: 0 };
  globalThis.alert = (m) => alerts.push(String(m));
  globalThis.confirm = (m) => { confirms.push(String(m)); return confirmAnswer; };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method });
    const body = u.endsWith('/rebase-prompt') ? bodies.rebasePrompt
      : u.endsWith('/sync') ? bodies.sync
      : u.endsWith('/merge') ? bodies.merge
      : undefined;
    return { ok: true, status: 200, json: async () => body };
  };
  const handles = installSessionActions({
    getActiveId: () => activeId, setActiveId: () => {}, getInstances: () => instances,
    refreshProjects: async () => { refreshes.projects++; if (refreshProjectsError) throw refreshProjectsError; }, refreshInstances: async () => {},
    selectInstance: () => {}, sidebar: {}, clearUnread: () => {}, headerUpdate: () => {},
  });
  return { ...handles, calls, alerts, confirms, refreshes };
}
