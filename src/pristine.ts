// Pristine conductors: who is showing one, and what happens when nobody is.
//
// A conductor started by New conductor stays pristine until its first prompt
// (Instance._endPristine). While pristine and with no draft title it is listed
// nowhere (`isHiddenPristine`), so its life hangs on the browser tabs showing
// it. Each tab declares itself over the socket: `view` adds that socket to the
// instance's presence set; `leave` or the socket's close removes it. When the
// set empties the conductor is ABANDONED — at once on a leave, after the grace
// window on a close (a reload re-announces itself only at the end of its first
// connect) or when no tab ever shows it. Abandoned with a blank last draft it
// is reaped; with text it is listed under that text. The rule reads only
// "still pristine", so a conductor already listed under a draft is reaped the
// same way when a later visit clears the draft.

import { normalizeTitle } from './sessionTitles.ts';

// Long enough for a reload whose project read times out once and retries
// (web/src/app/controller.ts READ_TIMEOUT_MS) plus a network blip; a hidden
// conductor costs nothing while it waits, and a short window kills one in front
// of the user.
export const PRISTINE_REAP_GRACE_MS = 60_000;

export interface PristineFacts { pristine: boolean; draftTitle: string | null }

export const isHiddenPristine = (i: PristineFacts): boolean => i.pristine && i.draftTitle === null;

// One line, capped like any title.
export const draftTitleOf = (text: string): string => normalizeTitle(text.replace(/\s+/g, ' '));

export interface PristineTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface PristineDeps {
  get(id: string): PristineFacts | undefined;
  reap(id: string): void;
  list(id: string, text: string): void;
  // Both read at arm time, so a test's seam applies to every later timer.
  timers(): PristineTimers;
  graceMs(): number;
}

interface Presence {
  viewers: Set<object>;
  // The newest text a viewer synced or left with.
  text: string;
  timer: unknown;
  timers: PristineTimers | null;
}

export class PristineTracker {
  #deps: PristineDeps;
  #byId = new Map<string, Presence>();

  constructor(deps: PristineDeps) {
    this.#deps = deps;
  }

  // A pristine instance was created: no viewer yet, so the window runs.
  track(id: string): void {
    this.#arm(id, this.#entry(id));
  }

  view(id: string, viewer: object): void {
    if (!this.#deps.get(id)?.pristine) return;
    const e = this.#entry(id);
    e.viewers.add(viewer);
    this.#disarm(e);
  }

  draft(id: string, text: string): void {
    if (!this.#deps.get(id)?.pristine) return;
    this.#entry(id).text = text;
  }

  // No `text` keeps the last synced draft.
  leave(id: string, viewer: object, text?: string): void {
    if (!this.#deps.get(id)?.pristine) return;
    const e = this.#entry(id);
    if (text !== undefined) e.text = text;
    e.viewers.delete(viewer);
    if (e.viewers.size > 0) return;
    this.#disarm(e);
    this.#abandon(id);
  }

  // A socket closed: every presence set it empties starts its window.
  drop(viewer: object): void {
    for (const [id, e] of this.#byId) {
      if (e.viewers.delete(viewer) && e.viewers.size === 0) this.#arm(id, e);
    }
  }

  forget(id: string): void {
    const e = this.#byId.get(id);
    if (!e) return;
    this.#disarm(e);
    this.#byId.delete(id);
  }

  #entry(id: string): Presence {
    let e = this.#byId.get(id);
    if (!e) {
      e = { viewers: new Set(), text: '', timer: null, timers: null };
      this.#byId.set(id, e);
    }
    return e;
  }

  #arm(id: string, e: Presence): void {
    this.#disarm(e);
    const timers = this.#deps.timers();
    e.timers = timers;
    e.timer = timers.setTimeout(() => {
      e.timer = null;
      e.timers = null;
      this.#abandon(id);
    }, this.#deps.graceMs());
  }

  #disarm(e: Presence): void {
    if (e.timer !== null && e.timers) e.timers.clearTimeout(e.timer);
    e.timer = null;
    e.timers = null;
  }

  #abandon(id: string): void {
    const e = this.#byId.get(id);
    if (!e) return;
    if (!this.#deps.get(id)?.pristine) { this.forget(id); return; }
    if (e.text.trim() === '') {
      this.forget(id);
      this.#deps.reap(id);
      return;
    }
    this.#deps.list(id, e.text);
  }
}
