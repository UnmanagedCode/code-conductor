// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SW_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js');

type FakeClient = { id: string; focused: boolean; visibilityState?: string; postedMessages: unknown[]; focus(): Promise<FakeClient>; postMessage(m: unknown): void };

function makeClient({ id, visible = false, focused = false, focusThrows = false, omitVisibilityState = false }: { id: string; visible?: boolean; focused?: boolean; focusThrows?: boolean; omitVisibilityState?: boolean }): FakeClient {
  const client: FakeClient = {
    id,
    focused,
    postedMessages: [],
    async focus() {
      if (focusThrows) throw new Error('focus failed');
      return client;
    },
    postMessage(msg) { client.postedMessages.push(msg); },
  };
  if (!omitVisibilityState) client.visibilityState = visible ? 'visible' : 'hidden';
  return client;
}

async function loadFakeSw(clients: FakeClient[]) {
  const opened: string[] = [];
  const handlers: Record<string, (e: any) => void> = {};
  vi.stubGlobal('self', {
    addEventListener(type: string, fn: (e: any) => void) { handlers[type] = fn; },
    skipWaiting() {},
    clients: {
      async matchAll() { return clients; },
      async openWindow(url: string) { opened.push(url); return null; },
    },
  });
  await import(/* @vite-ignore */ pathToFileURL(SW_PATH).href + `?t=${Math.random()}`);
  return { handlers, opened };
}

async function fireClick(handlers: Record<string, (e: any) => void>, data: unknown) {
  let closed = false;
  const event: any = {
    notification: { data, close: () => { closed = true; } },
    waitUntil(p: Promise<unknown>) { event._p = p; },
  };
  handlers.notificationclick(event);
  await event._p;
  return { closed };
}

afterEach(() => vi.unstubAllGlobals());

describe('web service worker notificationclick', () => {
  it('posts the resolved client the instance and session ids, and closes the notification', async () => {
    // Invariant: a click focuses a client and tells it which instance/session the ping was about.
    const client = makeClient({ id: 'c1', visible: true });
    const { handlers } = await loadFakeSw([client]);
    const { closed } = await fireClick(handlers, { project: 'p', instanceId: 'inst-42', sessionId: 'sess-42' });
    expect(closed).toBe(true);
    expect(client.postedMessages).toEqual([{ type: 'cc-notification-click', instanceId: 'inst-42', sessionId: 'sess-42' }]);
  });

  it('prefers a visible client over an earlier-listed hidden one', async () => {
    // Invariant: the client the user is looking at gets the click, not the first background tab.
    const hidden = makeClient({ id: 'hidden', visible: false });
    const visible = makeClient({ id: 'visible', visible: true });
    const { handlers, opened } = await loadFakeSw([hidden, visible]);
    await fireClick(handlers, { instanceId: 'i-7', sessionId: 's-7' });
    expect(hidden.postedMessages).toHaveLength(0);
    expect(visible.postedMessages).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('falls back to a focused client when visibilityState is absent', async () => {
    // Invariant: with no visibilityState, the focused flag picks the client.
    const other = makeClient({ id: 'other', omitVisibilityState: true });
    const focused = makeClient({ id: 'focused', focused: true, omitVisibilityState: true });
    expect('visibilityState' in other || 'visibilityState' in focused).toBe(false);
    const { handlers } = await loadFakeSw([other, focused]);
    await fireClick(handlers, { instanceId: 'i-7' });
    expect(other.postedMessages).toHaveLength(0);
    expect(focused.postedMessages).toHaveLength(1);
  });

  it('falls through to the next client when the preferred one fails to focus, and opens a window only when none can', async () => {
    // Invariant: a focus failure moves on to the remaining clients; openWindow is the last resort.
    const broken = makeClient({ id: 'broken', visible: true, focusThrows: true });
    const fallback = makeClient({ id: 'fallback', visible: false });
    const first = await loadFakeSw([broken, fallback]);
    await fireClick(first.handlers, { instanceId: 'i-7', sessionId: 's-7' });
    expect(fallback.postedMessages).toHaveLength(1);
    expect(first.opened).toEqual([]);

    const onlyBroken = makeClient({ id: 'broken2', visible: true, focusThrows: true });
    const second = await loadFakeSw([onlyBroken]);
    await fireClick(second.handlers, { instanceId: 'i-7', sessionId: 's-7' });
    expect(second.opened).toHaveLength(1);
    expect(second.opened[0]).toContain('s-7');
  });

  it('stale data without ids degrades to an id-less message or a bare open, without throwing', async () => {
    // Invariant: a notification fired by older code (no instanceId/sessionId) still focuses or opens the app.
    const client = makeClient({ id: 'c1' });
    const { handlers } = await loadFakeSw([client]);
    await expect(fireClick(handlers, { project: 'p' })).resolves.toBeDefined();
    expect(client.postedMessages).toEqual([{ type: 'cc-notification-click', instanceId: undefined, sessionId: undefined }]);

    const none = await loadFakeSw([]);
    await fireClick(none.handlers, { project: 'p' });
    expect(none.opened).toHaveLength(1);
    expect(none.opened[0]).not.toContain('session=');
  });

  it('missing notification data entirely does not throw', async () => {
    // Invariant: undefined notification.data is tolerated; with no clients the app is still opened.
    const none = await loadFakeSw([]);
    await expect(fireClick(none.handlers, undefined)).resolves.toBeDefined();
    expect(none.opened).toHaveLength(1);
  });
});
