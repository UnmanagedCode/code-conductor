// Runs the plugin bridge (../pluginBridge.js) as the classic script it is, against a
// scripted fake frame window: its location, history and parent, plus two <html>
// elements standing in for the host's and the frame's own documentElement.
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, '..', 'pluginBridge.js'), 'utf8');

export type BridgeOptions = {
  /** The frame is the top-level window (standalone). */
  top?: boolean;
  pathname?: string;
  origin?: string;
  /** The parent's documentElement; a detached <html> by default. */
  hostRoot?: HTMLElement;
  /** Reading `parent.document` throws a SecurityError, as a cross-origin parent's does. */
  parentThrows?: boolean;
  /** The parent's own `location` (pathname + search), which a link's href is compared with. */
  parentLocation?: { pathname: string; search: string };
  /** The frame document's readyState when the script runs. */
  readyState?: DocumentReadyState;
  /** Prepares the frame's own <html> before the script runs (e.g. a class the page set itself). */
  frameSetup?: (root: HTMLElement) => void;
};

export function runBridge({ top = false, pathname = '/plugins/hub/a', origin = 'http://h', hostRoot = document.createElement('html'), parentThrows = false, parentLocation = { pathname: '/', search: '' }, readyState = 'loading', frameSetup }: BridgeOptions = {}) {
  const posted: any[] = [];
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const docListeners: Record<string, ((e?: any) => void)[]> = {};
  const frameRoot = document.createElement('html');
  frameSetup?.(frameRoot);
  const loc = { pathname, search: '?q=1', hash: '', origin };
  const hist = { replaced: [] as any[], pushState() {}, replaceState(_s: unknown, _t: unknown, url: string) { hist.replaced.push(url); loc.pathname = url; } };
  const parent: any = { postMessage: (m: unknown, o: string) => posted.push([m, o]) };
  Object.defineProperty(parent, 'document', {
    get() {
      if (parentThrows) throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
      return { documentElement: hostRoot };
    },
  });
  Object.defineProperty(parent, 'location', {
    get() {
      if (parentThrows) throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
      return parentLocation;
    },
  });
  const win: any = {
    location: loc, history: hist, parent,
    addEventListener: (t: string, f: (e: any) => void) => { (listeners[t] ??= []).push(f); },
    dispatchEvent: (e: any) => { for (const f of listeners[e.type] ?? []) f(e); },
  };
  win.self = win;
  win.top = top ? win : {};
  const doc = {
    readyState,
    documentElement: frameRoot,
    addEventListener: (t: string, f: (e?: any) => void) => { (docListeners[t] ??= []).push(f); },
  };
  new Function('window', 'history', 'document', 'PopStateEvent', src)(win, hist, doc, class { type: string; constructor(t: string) { this.type = t; } });
  /** Fires the frame document's DOMContentLoaded listeners. */
  const contentLoaded = () => { for (const f of docListeners.DOMContentLoaded ?? []) f(); };
  /** Dispatches a primary-button click on `target` to the frame document's click listeners; `prevented` is whether one called preventDefault. */
  const click = (target: Element, init: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }> = {}) => {
    let prevented = false;
    const ev = { target, button: 0, ...init, preventDefault() { prevented = true; ev.defaultPrevented = true; } } as { defaultPrevented?: boolean };
    for (const f of docListeners.click ?? []) f(ev);
    return { prevented };
  };
  return { posted, win, click, hist, listeners, docListeners, contentLoaded, frameRoot, hostRoot };
}

/** Lets pending MutationObserver callbacks run. */
export const observerTurn = () => new Promise<void>((r) => setTimeout(r, 0));
