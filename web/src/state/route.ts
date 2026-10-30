// Hash routing. The hash names the main view: a session (`#session=<sid>`, the
// anchor a reload restores), or a full-page view — `#settings[/<section>]`,
// `#costs`, `#commits`, `#review`, `#plugin/<id>/<subpath>`. Full-page views are
// opened with a history push and closed with history.back(), so the browser's
// back button and Escape behave alike.
import { createStore, useStore } from './createStore';
import { readSessionAnchor, writeSessionAnchor } from '@shared/anchor';

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

/** The host of cc's in-app link form, `http://cc.internal/#<view>`: it resolves nowhere, so only cc acts on it. */
export const CC_LINK_HOST = 'cc.internal';

/** The views a link to cc may open in-app. #review/#commits carry params a hash can't (viewStore), and a #session= hash selects nothing on push (the controller selects on popstate only), so neither is a link target. */
const LINKABLE: ReadonlySet<MainView> = new Set(['plugin', 'settings', 'costs']);

/**
 * The hash a link to cc opens in-app, or null. A link to cc is `http(s)://cc.internal/#<view>` (exact host, path `/`,
 * no search) or a URL on cc's own page (same origin, path and search; a bare `#…` resolves there); neither may carry
 * userinfo. The result is the link's normalized fragment. A plugin link must name an id, and its frame URL
 * (`/plugins/<id>/<subpath>`, built as PluginView/PluginFrames build it) must stay under `/plugins/<id>/` on this
 * origin. That rejects dot segments (also `%2e%2e` and `\`) and an id that is not one plain path segment.
 */
export function viewLinkHash(href: string): string | null {
  let u: URL;
  try { u = new URL(href, location.href); } catch { return null; }
  if (u.username || u.password) return null;
  const internal = (u.protocol === 'http:' || u.protocol === 'https:') && u.host === CC_LINK_HOST && u.pathname === '/' && u.search === '';
  const ownPage = u.origin === location.origin && u.pathname === location.pathname && u.search === location.search;
  if (!internal && !ownPage) return null;
  const hash = u.hash;
  let route: Route;
  try { route = parseHash(hash); } catch { return null; }
  if (!LINKABLE.has(route.view)) return null;
  if (route.view !== 'plugin') return hash;
  if (!route.pluginId) return null;
  const base = `/plugins/${route.pluginId}/`;
  try {
    const frame = new URL(base + route.pluginPath, location.origin);
    return frame.origin === location.origin && frame.pathname.startsWith(base) ? hash : null;
  } catch { return null; }
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

/**
 * The state of a history entry this app pushed a full-page view onto. Closing a
 * view from such an entry is a history.back(); from any other (a deep link, an
 * address-bar hash) it writes the active session's anchor, so Back never steps
 * off the app.
 */
const VIEW_ENTRY = { ccView: 1 } as const;

/** Open a full-page view by pushing its hash. */
export function openView(hash: string) {
  if (location.hash === hash) return;
  history.pushState(VIEW_ENTRY, '', `${location.pathname}${location.search}${hash}`);
  sync();
}

/** Replace the current hash without a history entry (e.g. a settings section); the entry stays a pushed view's if it was one. */
export function replaceHash(hash: string) {
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  sync();
}

/**
 * Leave a full-page view: back to wherever the user came from when this tab
 * opened it, else (a deep link) to the active session's anchor.
 */
export function closeView(activeSessionId: string | null) {
  if (history.state?.ccView === VIEW_ENTRY.ccView) {
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
