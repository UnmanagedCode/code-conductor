// Drives the plugin host the way the app mounts it: the real App, its network
// answered at `fetch`, each frame given a stand-in window that records what the
// host posts to it (happy-dom loads no frame document), and the bridge's route
// messages dispatched as a frame posts them.
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from '@/App';
import { appStore } from '@/state/app';
import { syncRoute } from '@/state/route';
import type { Instance } from '@/state/types';
import { uiStore } from '@/app/ui';
import { pluginFrames, type PluginRow } from '../plugins';

export type StatusRow = { state?: string; enabled?: boolean; frontendKeepAlive?: boolean };
/** A status read's answer: a row, an HTTP error status, a rejected fetch, or a 200 whose body does not parse. */
export type Answer = StatusRow | number | 'network' | 'unreadable';
/** What the host posted to a frame. */
export type StandIn = { posted: unknown[] };

export const keepRow = (over: StatusRow = {}): StatusRow => ({ state: 'ready', enabled: true, frontendKeepAlive: true, ...over });
export const plainRow = (over: StatusRow = {}): StatusRow => keepRow({ frontendKeepAlive: false, ...over });
export const navigate = (path: string) => ({ cc: 1, type: 'navigate', path });

/** The session the app has open; Conductor returns to its anchor. */
export const ACTIVE: Instance = { id: 'i1', project: 'p', status: 'idle', sessionId: 'sess-1', mode: 'default' };

/** The network the host talks to; a test changes it between steps. */
export const net = {
  status: {} as Record<string, Answer>,
  catalog: [] as PluginRow[],
  /** Every request, as `<METHOD> <url>`. */
  calls: [] as string[],
  /** When set, POST /start answers with this. */
  heldStart: null as Promise<Response> | null,
  /** When set, POST /start refuses with a 409. */
  refuseStart: false,
  /** A plugin's next status read answers with its entry here, once (see holdStatus). */
  heldStatus: {} as Record<string, Promise<Response>>,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function answer(url: string, method: string): Promise<Response> {
  net.calls.push(`${method} ${url}`);
  if (url === '/api/plugins') return json({ rows: net.catalog });
  const m = /^\/api\/plugins\/([^/]+)\/(status|start)$/.exec(url);
  if (!m) return json({});
  const row = net.status[m[1]];
  const held = m[2] === 'status' ? net.heldStatus[m[1]] : undefined;
  if (held) { delete net.heldStatus[m[1]]; return held; }
  if (row === undefined) return json({ error: 'unknown plugin' }, 404);
  if (row === 'network') throw new TypeError('Failed to fetch');
  if (row === 'unreadable') return new Response('', { status: 200 });
  if (typeof row === 'number') return json({ error: `HTTP ${row}` }, row);
  if (m[2] === 'status') return json({ name: m[1], ...row });
  if (net.heldStart) return net.heldStart;
  if (net.refuseStart) return json({ error: 'plugin is disabled' }, 409);
  row.state = 'ready';
  return json({ state: 'ready' });
}

/** A fresh network, the URL at `url`, the drawer closed and one live session selected. */
export function resetHost(url = '/') {
  net.status = {};
  net.catalog = [];
  net.calls = [];
  net.heldStart = null;
  net.refuseStart = false;
  net.heldStatus = {};
  vi.stubGlobal('fetch', vi.fn((url: string, opts: RequestInit = {}) => answer(url, opts.method ?? 'GET')));
  history.replaceState(null, '', url);
  syncRoute();
  uiStore.set({ sidebarOpen: false });
  appStore.set({
    connection: 'open', everDropped: false, activeId: ACTIVE.id, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [ACTIVE],
  });
}

/** Ends every frame through the host's own paths: leaving the view, then an evicting action naming each resident plugin. */
export async function endHost() {
  pluginFrames.leave();
  await act(async () => { await pluginFrames.reconcile({ action: 'restart', ids: pluginFrames.residentIds() }); });
  vi.unstubAllGlobals();
}

export const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

export async function mountApp() {
  render(<App />);
  await settle();
}

/** Holds plugin `id`'s next status read until the returned release answers it with `row`. */
export function holdStatus(id: string): (row: StatusRow) => Promise<void> {
  let release!: (r: Response) => void;
  net.heldStatus[id] = new Promise((r) => { release = r; });
  return async (row) => {
    await act(async () => { release(json({ name: id, ...row })); });
    await settle();
  };
}

/** Sets the hash as a link or the address bar does, and lets the host follow. */
export async function go(hash: string) {
  location.hash = hash;
  await settle();
}

export const pluginView = () => document.querySelector('[data-view="plugin"]') as HTMLElement;
export const viewOpen = () => pluginView().getAttribute('aria-hidden') === 'false';
export const residentFrame = (id: string) => document.querySelector(`iframe[data-plugin-frame="resident"][data-plugin-id="${id}"]`) as HTMLIFrameElement | null;
export const sharedFrame = () => document.querySelector('iframe[data-plugin-frame="shared"]') as HTMLIFrameElement | null;
/** The frames in the plugin view that are not hidden. */
export const shownFrames = () => [...pluginView().querySelectorAll('iframe')].filter((f) => !f.hidden);

/** Pins a stand-in window on `frame`. */
export function standInWindow(frame: HTMLIFrameElement): StandIn {
  const win = { posted: [] as unknown[], postMessage(m: unknown) { win.posted.push(m); } };
  Object.defineProperty(frame, 'contentWindow', { value: win, configurable: true });
  return win;
}

/** `from`'s frame posts `data` to the app, as a same-origin page does. */
export function postFrom(from: StandIn, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: location.origin, source: from as unknown as Window }));
  });
}

/** The bridge in `from`'s frame reports its route, as a plugin page's own navigation does. */
export const postRoute = (from: StandIn, path: string) => postFrom(from, { cc: 1, type: 'route', path });

// ── the plugin dock (the desktop column beside the session) ─────────────────

export const column = () => document.querySelector('[data-plugin-column]') as HTMLElement | null;
export const host = () => document.querySelector('[data-plugin-host]') as HTMLElement | null;
export const rail = () => document.querySelector('nav[aria-label="Plugin dock"]') as HTMLElement | null;
/** A rail control by label; an app's icon also while it is named as docked. */
export const railButton = (label: string) => rail()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"], button[aria-label="${label} (docked)"]`) ?? null;
export const dockHandle = () => document.querySelector('[role="separator"][aria-label="Resize plugin dock"]') as HTMLElement | null;

/** A drag of the handle by `dx` px: down, one move, up. */
export function dragBy(el: HTMLElement, dx: number) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500, pointerId: 1 }));
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 500 + dx, pointerId: 1 }));
  });
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 500 + dx, pointerId: 1 }));
  });
}

type Observed = { cb: (entries: unknown[]) => void; targets: Set<Element> };
const observed: Observed[] = [];

/** Replaces happy-dom's ResizeObserver (whose observe never calls back) with one `emitWidth` drives; `endHost` unstubs it. */
export function stubResizeObserver() {
  observed.length = 0;
  vi.stubGlobal('ResizeObserver', class {
    private rec: Observed;
    constructor(cb: (entries: unknown[]) => void) { this.rec = { cb, targets: new Set() }; observed.push(this.rec); }
    observe(el: Element) { this.rec.targets.add(el); }
    unobserve(el: Element) { this.rec.targets.delete(el); }
    disconnect() { this.rec.targets.clear(); }
  });
}

/** The main row (the plugin column's parent) reports a content width of `px`. */
export function emitWidth(px: number) {
  const row = column()?.parentElement;
  act(() => {
    for (const o of observed) if (row && o.targets.has(row)) o.cb([{ target: row, contentRect: { width: px } }]);
  });
}
