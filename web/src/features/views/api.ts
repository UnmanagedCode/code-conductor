// Full-page views (Settings, review, commit history, costs, plugin frames) are
// opened through here. Each pushes its hash (state/route.ts); the parameters a
// hash can't carry ride in `viewStore`.
import { createStore } from '@/state/createStore';
import { openView, replaceHash } from '@/state/route';

export type ReviewParams = { title: string; url: string };
export type CommitsParams = { project: string; worktree: string | null };

// The params also persist per tab (sessionStorage), so a reload on #review or
// #commits reopens the same view.
const PARAMS_KEY = 'code-conductor:view-params';

function readParams(): { review: ReviewParams | null; commits: CommitsParams | null } {
  try {
    const v = JSON.parse(sessionStorage.getItem(PARAMS_KEY) ?? 'null');
    return { review: v?.review ?? null, commits: v?.commits ?? null };
  } catch {
    return { review: null, commits: null };
  }
}

export const viewStore = createStore<{ review: ReviewParams | null; commits: CommitsParams | null }>(readParams());

viewStore.subscribe(() => {
  try { sessionStorage.setItem(PARAMS_KEY, JSON.stringify(viewStore.get())); } catch { /* storage unavailable */ }
});

export function openReview(params: ReviewParams) {
  viewStore.set({ review: params });
  openView('#review');
}

export function openCommits(project: string, worktree: string | null = null) {
  viewStore.set({ commits: { project, worktree } });
  openView('#commits');
}

export function openCosts() {
  openView('#costs');
}

export function openSettings(section?: string) {
  const hash = section ? `#settings/${section}` : '#settings';
  if (location.hash.startsWith('#settings')) replaceHash(hash);
  else openView(hash);
}

export function openPlugin(id: string, subpath = '') {
  openView(`#plugin/${encodeURIComponent(id)}/${subpath}`);
}
