// Hash routing. The hash names the main view: a session (`#session=<sid>`, the
// anchor a reload restores), or a full-page view — `#settings[/<section>]`,
// `#costs`, `#commits`, `#review`, `#plugin/<id>/<subpath>`. Full-page views are
// opened with a history push and closed with history.back(), so the browser's
// back button and Escape behave alike.
import { createStore, useStore } from './createStore';
import { readSessionAnchor, writeSessionAnchor } from '@/lib/core/anchor.js';

export type MainView = 'session' | 'settings' | 'costs' | 'commits' | 'review' | 'plugin';

export type Route = {
  view: MainView;
  /** `#session=<sid>` anchor, for view 'session'. */
  sessionId: string | null;
  /** Settings section, or the plugin id + subpath. */
  section: string | null;
  pluginId: string | null;
  pluginPath: string;
  hash: string;
};

export function parseHash(hash: string): Route {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const base: Route = { view: 'session', sessionId: null, section: null, pluginId: null, pluginPath: '', hash };
  if (h === 'settings' || h.startsWith('settings/')) return { ...base, view: 'settings', section: h.slice('settings/'.length) || null };
  if (h === 'costs') return { ...base, view: 'costs' };
  if (h === 'commits') return { ...base, view: 'commits' };
  if (h === 'review') return { ...base, view: 'review' };
  if (h.startsWith('plugin/')) {
    const rest = h.slice('plugin/'.length);
    const slash = rest.indexOf('/');
    const id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    return { ...base, view: 'plugin', pluginId: id, pluginPath: slash < 0 ? '' : rest.slice(slash + 1) };
  }
  return { ...base, sessionId: readSessionAnchor() };
}

export const routeStore = createStore<{ route: Route }>({ route: parseHash(location.hash) });

function sync() {
  const next = parseHash(location.hash);
  if (next.hash !== routeStore.get().route.hash) routeStore.set({ route: next });
}
addEventListener('hashchange', sync);
addEventListener('popstate', sync);

export function useRoute(): Route {
  return useStore(routeStore, (s) => s.route);
}

/** Views this tab pushed — closing one of them is a history.back(). */
let pushedViews = 0;

/** Open a full-page view by pushing its hash. */
export function openView(hash: string) {
  if (location.hash === hash) return;
  history.pushState(null, '', `${location.pathname}${location.search}${hash}`);
  pushedViews++;
  sync();
}

/** Replace the current hash without a history entry (e.g. a settings section). */
export function replaceHash(hash: string) {
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  sync();
}

/**
 * Leave a full-page view: back to wherever the user came from when this tab
 * opened it, else (a deep link) to the active session's anchor.
 */
export function closeView(activeSessionId: string | null) {
  if (pushedViews > 0) {
    pushedViews--;
    history.back();
    return;
  }
  writeSessionAnchor(activeSessionId);
  sync();
}

/** Called after the anchor is rewritten programmatically (writeSessionAnchor / pushSessionAnchor). */
export function syncRoute() {
  sync();
}
