// Plugin frontends in same-origin iframes, owning the `#plugin/<id>/<subpath>`
// hash space. Frames are managed imperatively inside one host element React
// mounts once (moving an iframe in the DOM reloads it).
//
// Loading is REST-driven so an enabled-but-stopped plugin auto-starts with a
// visible overlay: GET status → (POST start when not ready) → frame src; a
// start failure shows the error + crash tail with Retry.
//
// Two frame tiers, by the status row's `frontendKeepAlive`:
//   - a plain plugin loads into one shared frame, dropped when the view is left
//     or another plugin shows, so a closed plugin costs nothing;
//   - a keep-alive plugin gets its own resident frame on first show. Leaving
//     only hides it (its page — a call, a stream — keeps running); re-entry
//     reveals it with no /start and no src change. A resident frame is evicted
//     only when its row stops passing `keepsResident` (checked in the
//     background on re-entry and by `reconcile()` after a Settings → Plugins
//     action) or when that action put new code under it (EVICTING_ACTIONS);
//     a renewed frame that is on screen reloads in place, a disqualified one
//     is not started again.
//
// Parent side of the bridge (the root /pluginBridge.js, ./pluginBridge.js, runs in the frame):
// child `route` messages from the shown frame go through the RouteMirror
// `enter` was given — into the hash in full view (the route store's
// replaceHash: no history entry, no hashchange, no reload loop), into the
// dock's saved subpath in split — so whatever names the frame's place always
// reads where the frame is, and an outside change back to an earlier subpath
// still reads as a change; an outside subpath change is forwarded as `navigate`.
// `openLink` (a plugin link the page's bridge caught) goes to the link handler (dock.ts `followFrameLink`).
// `ready` and the id-carrying session calls (`openSession` / `sendPrompt`) from
// any known frame go to the BridgeHandler (pluginSession.ts); `broadcast` posts
// to every frame, hidden resident ones included.
import { ApiError, apiFetch, apiResponse, readApiBody } from '@shared/http';
import { createSignal, createStore } from '@/state/createStore';
import { replaceHash, viewLinkHash } from '@/state/route';

export type PluginTarget = { id: string; subpath: string };
/** Where the shown frame's own navigation is recorded. */
export type RouteMirror = (id: string, path: string) => void;

/** The full view's mirror: the frame's route is the hash. */
export const hashMirror: RouteMirror = (id, path) => {
  const hash = `#plugin/${id}${path}`;
  if (location.hash !== hash) replaceHash(hash);
};
/** Parent-side session awareness (pluginSession.ts); `reply` posts to the frame that sent the message. */
export type BridgeHandler = {
  ready(reply: (m: unknown) => void): void;
  call(d: { type: string; id: string; [k: string]: unknown }, reply: (m: unknown) => void): void;
};
type Record_ = { id: string; subpath: string; frame: HTMLIFrameElement };
type Current = PluginTarget | Record_;

export const RESIDENT_STATES = ['starting', 'ready', 'crashed', 'failed'];
export const EVICTING_ACTIONS = ['restart', 'update', 'version'];
export const RESIDENT_SUFFIX = ' (running)';

export function keepsResident(row: { enabled?: boolean; frontendKeepAlive?: boolean; state?: string } | null) {
  return !!row && row.enabled === true && row.frontendKeepAlive === true && RESIDENT_STATES.includes(row.state ?? '');
}

export type Overlay = { message: string; retry: PluginTarget | null } | null;
export const overlayStore = createStore<{ overlay: Overlay }>({ overlay: null });
/** Bumped whenever the resident set changes (the app switcher labels resident frames). */
export const residentSignal = createSignal();

const frameClass = 'absolute inset-0 h-full w-full border-0 bg-transparent';

class PluginFrames {
  private host: HTMLElement | null = null;
  private shared: HTMLIFrameElement | null = null;
  /** The target the shared frame was loaded for; mid-load, `current` already names the next one. */
  private sharedTarget: PluginTarget | null = null;
  private current: Current | null = null;
  private token = 0;
  private mirror: RouteMirror = hashMirror;
  private handler: BridgeHandler | null = null;
  private linkHandler: ((hash: string) => void) | null = null;
  readonly resident = new Map<string, Record_>();

  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('message', (ev) => this.onMessage(ev));
  }

  attach(host: HTMLElement | null) {
    this.host = host;
  }

  setBridgeHandler(h: BridgeHandler | null) {
    this.handler = h;
  }

  setLinkHandler(h: ((hash: string) => void) | null) {
    this.linkHandler = h;
  }

  /** Posts to the shared frame and every resident frame, hidden ones included. */
  broadcast(msg: unknown) {
    this.shared?.contentWindow?.postMessage(msg, location.origin);
    for (const r of this.resident.values()) r.frame.contentWindow?.postMessage(msg, location.origin);
  }

  residentIds() {
    return [...this.resident.keys()];
  }

  currentId() {
    return this.current?.id ?? null;
  }

  /** The current plugin's frame; none while it is still loading, even with another plugin's page in the view. */
  private activeFrame(): HTMLIFrameElement | null {
    const c = this.current;
    if (c && 'frame' in c) return c.frame;
    return c && c === this.sharedTarget ? this.shared : null;
  }

  private setOverlay(o: Overlay) {
    overlayStore.set({ overlay: o });
  }

  // Until the plugin document loads, Safari paints an opaque light backdrop
  // behind a frame whose colour scheme differs from the app's, so every frame
  // stays visibility:hidden from its src until its own load. src is set before
  // insertion so no initial about:blank load reveals it early, and each plain
  // load gets a fresh frame: re-setting src to a URL differing only by fragment
  // would fire no load and leave the frame hidden.
  private mountShared(target: PluginTarget) {
    this.dropShared();
    const f = document.createElement('iframe');
    f.className = frameClass;
    f.dataset.pluginFrame = 'shared';
    f.title = 'Plugin';
    f.addEventListener('load', () => {
      f.style.visibility = '';
      if (this.current === target) this.setOverlay(null);
    });
    f.style.visibility = 'hidden';
    f.src = `/plugins/${target.id}${target.subpath}`;
    this.host?.appendChild(f);
    this.shared = f;
    this.sharedTarget = target;
  }

  // A fresh frame's initial document is transparent over the app background;
  // navigating the old one to about:blank would paint opaque white in dark mode.
  private dropShared() {
    this.shared?.remove();
    this.shared = null;
    this.sharedTarget = null;
  }

  private async api(method: string, path: string) {
    const r = await apiResponse(path, { method });
    const data = await readApiBody<any>(r);
    // A success whose body doesn't parse is a failed read, not an empty row.
    if (data === null) throw new Error(`unreadable response (HTTP ${r.status})`);
    return data;
  }

  private statusOf(id: string) {
    return this.api('GET', `/api/plugins/${encodeURIComponent(id)}/status`);
  }

  /** Only a 404 (unknown id) evicts on a failed read: a blip must not end a call. */
  private async stillResident(id: string) {
    try { return keepsResident(await this.statusOf(id)); } catch (e) { return !(e instanceof ApiError && e.status === 404); }
  }

  private evict(record: Record_) {
    if (this.resident.get(record.id) !== record) return;
    record.frame.remove();
    this.resident.delete(record.id);
    if (this.current === record) this.current = null;
    residentSignal.bump();
  }

  private mountResident(target: PluginTarget) {
    const frame = document.createElement('iframe');
    frame.className = frameClass;
    frame.dataset.pluginId = target.id;
    frame.dataset.pluginFrame = 'resident';
    frame.title = target.id;
    const record: Record_ = { id: target.id, subpath: target.subpath, frame };
    frame.addEventListener('load', () => {
      frame.style.visibility = '';
      if (this.current === record) this.setOverlay(null);
    });
    frame.style.visibility = 'hidden';
    frame.src = `/plugins/${target.id}${target.subpath}`;
    this.host?.appendChild(frame);
    this.resident.set(target.id, record);
    this.current = record;
    this.dropShared();
    residentSignal.bump();
  }

  private showResident(record: Record_, target: PluginTarget) {
    const token = ++this.token;
    this.setOverlay(null);
    this.dropShared();
    for (const r of this.resident.values()) r.frame.hidden = r !== record;
    this.current = record;
    if (target.subpath === '/' || target.subpath === record.subpath) {
      this.mirror(record.id, record.subpath);
    } else {
      record.subpath = target.subpath;
      record.frame.contentWindow?.postMessage({ cc: 1, type: 'navigate', path: target.subpath }, location.origin);
    }
    void this.stillResident(record.id).then((keep) => {
      if (keep || token !== this.token) return;
      this.evict(record);
      void this.load(target);
    });
  }

  async load(target: PluginTarget) {
    const record = this.resident.get(target.id);
    if (record) { this.showResident(record, target); return; }
    for (const r of this.resident.values()) r.frame.hidden = true;
    this.current = target;
    this.setOverlay(null);
    const token = ++this.token;
    try {
      const st = await this.statusOf(target.id);
      if (token !== this.token) return;
      if (st.state !== 'ready') {
        // Lazy start: the explicit start doubles as the readiness wait.
        this.setOverlay({ message: `Starting ${st.name || target.id}…`, retry: null });
        await this.api('POST', `/api/plugins/${encodeURIComponent(target.id)}/start`);
        if (token !== this.token) return;
      }
      if (st.frontendKeepAlive) this.mountResident(target);
      else this.mountShared(target);
    } catch (e: any) {
      if (token !== this.token) return;
      const tail = e instanceof ApiError && e.tail;
      this.setOverlay({ message: `${target.id}: ${e.message}${tail ? `\n\n${tail}` : ''}`, retry: target });
    }
  }

  /** Enter or move within the plugin space; `mirror` records the shown frame's own navigation from here on, even when nothing else changes. */
  enter(target: PluginTarget, mirror: RouteMirror = hashMirror) {
    this.mirror = mirror;
    const cur = this.current;
    if (!cur || cur.id !== target.id) { void this.load(target); return; }
    if (target.subpath !== cur.subpath) {
      // Same plugin, new subpath from outside the frame: steer it, don't reload.
      cur.subpath = target.subpath;
      this.activeFrame()?.contentWindow?.postMessage({ cc: 1, type: 'navigate', path: target.subpath }, location.origin);
    }
  }

  /** The view closed: plain frames end, resident frames only hide. */
  leave() {
    this.current = null;
    this.token++;
    this.setOverlay(null);
    this.dropShared();
    for (const r of this.resident.values()) r.frame.hidden = true;
  }

  /** After a Settings → Plugins action: evict what no longer qualifies, or got new code; the on-screen plugin reloads only in the second case. */
  async reconcile(change?: { action?: string; ids?: string[] } | null) {
    const renewed = change?.action && EVICTING_ACTIONS.includes(change.action) ? change.ids ?? [] : [];
    await Promise.all([...this.resident.values()].map(async (record) => {
      if (!renewed.includes(record.id) && (await this.stillResident(record.id))) return;
      const reload = this.current === record && renewed.includes(record.id);
      this.evict(record);
      if (reload) void this.load({ id: record.id, subpath: record.subpath });
    }));
  }

  // Child → parent ({cc:1}; ready / route / openLink / openSession / sendPrompt), attributed by the frame that posted
  // it. A frame that is not the current plugin's (a hidden resident one, or the
  // page being replaced while the next plugin loads) has its route tracked on
  // its own record only — the user is somewhere else.
  private onMessage(ev: MessageEvent) {
    if (ev.origin !== location.origin || !ev.source) return;
    const record: Current | null | undefined = this.shared && ev.source === this.shared.contentWindow
      ? this.sharedTarget
      : [...this.resident.values()].find((r) => ev.source === r.frame.contentWindow);
    if (!record) return;
    const active = record === this.current;
    const d = ev.data;
    if (!d || d.cc !== 1) return;
    // A path without its leading slash would splice into the id part of the hash.
    if (d.type === 'route' && typeof d.path === 'string' && d.path.startsWith('/')) {
      record.subpath = d.path;
      if (active) this.mirror(record.id, d.path);
      return;
    }
    // A link the page's bridge caught: honoured only from the shown frame, and only a hash a transcript link may open.
    if (d.type === 'openLink') {
      const hash = active && typeof d.hash === 'string' ? viewLinkHash(d.hash) : null;
      if (hash) this.linkHandler?.(hash);
      return;
    }
    const reply = (m: unknown) => (ev.source as Window).postMessage(m, location.origin);
    if (d.type === 'ready') this.handler?.ready(reply);
    else if ((d.type === 'openSession' || d.type === 'sendPrompt') && typeof d.id === 'string') this.handler?.call(d, reply);
  }
}

export const pluginFrames = new PluginFrames();

export type PluginRow = { id: string; name: string; navLabel?: string | null; enabled?: boolean; hasFrontend?: boolean; frontendKeepAlive?: boolean; state?: string };
/** A plugin's name as the app switcher and the plugin view's top bar show it. */
export const appLabel = (p: Pick<PluginRow, 'name' | 'navLabel'>) => p.navLabel || p.name;

/** Plugins that contribute a frontend the app switcher offers. */
export const catalogStore = createStore<{ apps: PluginRow[] }>({ apps: [] });

export async function refreshCatalog() {
  try {
    const rows = (await apiFetch<{ rows?: PluginRow[] } | null>('/api/plugins'))?.rows ?? [];
    catalogStore.set({ apps: rows.filter((p) => p.enabled && p.hasFrontend) });
  } catch {
    catalogStore.set({ apps: [] });
  }
}
