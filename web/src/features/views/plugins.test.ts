// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVICTING_ACTIONS, keepsResident, pluginFrames, overlayStore } from './plugins';

afterEach(() => {
  vi.unstubAllGlobals();
  pluginFrames.leave();
  for (const id of pluginFrames.residentIds()) (pluginFrames as any).evict(pluginFrames.resident.get(id));
  document.body.innerHTML = '';
});

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('keepsResident', () => {
  it('keeps an enabled keep-alive frame in the allowlisted states only', () => {
    expect(keepsResident({ enabled: true, frontendKeepAlive: true, state: 'ready' })).toBe(true);
    expect(keepsResident({ enabled: true, frontendKeepAlive: true, state: 'crashed' })).toBe(true);
    expect(keepsResident({ enabled: true, frontendKeepAlive: true, state: 'stopped' })).toBe(false);
    expect(keepsResident({ enabled: false, frontendKeepAlive: true, state: 'ready' })).toBe(false);
    expect(keepsResident({ enabled: true, frontendKeepAlive: false, state: 'ready' })).toBe(false);
    expect(EVICTING_ACTIONS).toEqual(['restart', 'update', 'version']);
  });
});

function host() {
  const h = document.createElement('div');
  document.body.appendChild(h);
  pluginFrames.attach(h);
  return h;
}

describe('plugin frames', () => {
  it('a plain plugin loads into the shared frame, which leaving drops', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ state: 'ready', frontendKeepAlive: false })));
    const h = host();
    await pluginFrames.load({ id: 'hub', subpath: '/x' });
    const f = h.querySelector('iframe')!;
    expect(f.getAttribute('src')).toBe('/plugins/hub/x');
    pluginFrames.leave();
    expect(h.querySelector('iframe')).toBeNull();
  });

  it('a stopped plugin is started first, behind an overlay', async () => {
    let release!: (r: Response) => void;
    const started = new Promise<Response>((r) => { release = r; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ state: 'stopped', name: 'Hub' }))
      .mockReturnValueOnce(started);
    vi.stubGlobal('fetch', fetchMock);
    host();
    const p = pluginFrames.load({ id: 'hub', subpath: '/' });
    await vi.waitFor(() => expect(overlayStore.get().overlay?.message).toBe('Starting Hub…'));
    release(ok({ ok: true }));
    await p;
    expect(fetchMock.mock.calls[1]).toEqual(['/api/plugins/hub/start', expect.objectContaining({ method: 'POST' })]);
    expect(overlayStore.get().overlay?.message).toBe('Starting Hub…');
    document.querySelector('iframe')!.dispatchEvent(new Event('load'));
    expect(overlayStore.get().overlay).toBeNull();
  });

  it('a frame is hidden from its src until its own load, and each plain load gets a fresh one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ state: 'ready', frontendKeepAlive: false })));
    const h = host();
    await pluginFrames.load({ id: 'hub', subpath: '/x#f' });
    const a = h.querySelector('iframe')!;
    expect(a.getAttribute('src')).toBe('/plugins/hub/x#f');
    expect(a.style.visibility).toBe('hidden');
    a.dispatchEvent(new Event('load'));
    expect(a.style.visibility).toBe('');
    await pluginFrames.load({ id: 'other', subpath: '/' });
    const b = h.querySelector('iframe')!;
    expect(b).not.toBe(a);
    expect(a.isConnected).toBe(false);
    expect(h.querySelectorAll('iframe')).toHaveLength(1);
    expect(b.style.visibility).toBe('hidden');
    a.dispatchEvent(new Event('load'));
    expect(b.style.visibility).toBe('hidden');
    b.dispatchEvent(new Event('load'));
    expect(b.style.visibility).toBe('');
    // Back to the same URL: a new frame again, so a full load (not a fragment hop) reveals it.
    await pluginFrames.load({ id: 'other', subpath: '/' });
    const c = h.querySelector('iframe')!;
    expect(c).not.toBe(b);
    expect(c.style.visibility).toBe('hidden');
    c.dispatchEvent(new Event('load'));
    expect(c.style.visibility).toBe('');
  });

  it('a resident frame that loads while the view is away comes back visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ state: 'ready', enabled: true, frontendKeepAlive: true })));
    const h = host();
    await pluginFrames.load({ id: 'call', subpath: '/' });
    const frame = h.querySelector('iframe')!;
    expect(frame.style.visibility).toBe('hidden');
    pluginFrames.leave();
    frame.dispatchEvent(new Event('load'));
    expect(frame.style.visibility).toBe('');
    pluginFrames.enter({ id: 'call', subpath: '/' });
    await vi.waitFor(() => expect(frame.hidden).toBe(false));
    expect(h.querySelector('iframe')).toBe(frame);
    expect(frame.getAttribute('src')).toBe('/plugins/call/');
    expect(frame.style.visibility).toBe('');
  });

  it('a start failure offers Retry with the crash tail', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ state: 'stopped' }))
      .mockResolvedValueOnce(ok({ error: 'exited 1', tail: 'trace' }, 503)));
    host();
    await pluginFrames.load({ id: 'hub', subpath: '/' });
    expect(overlayStore.get().overlay).toEqual({ message: 'hub: exited 1\n\ntrace', retry: { id: 'hub', subpath: '/' } });
  });

  it('a keep-alive frame survives leaving, is revealed without reloading, and an evicting action ends it while hidden', async () => {
    const fetchMock = vi.fn(async () => ok({ state: 'ready', enabled: true, frontendKeepAlive: true }));
    vi.stubGlobal('fetch', fetchMock);
    const h = host();
    await pluginFrames.load({ id: 'call', subpath: '/' });
    const frame = h.querySelector('iframe')!;
    expect(pluginFrames.residentIds()).toEqual(['call']);
    pluginFrames.leave();
    expect(frame.isConnected).toBe(true);
    expect(frame.hidden).toBe(true);
    pluginFrames.enter({ id: 'call', subpath: '/' });
    await vi.waitFor(() => expect(frame.hidden).toBe(false));
    expect(h.querySelector('iframe')).toBe(frame);
    expect(frame.getAttribute('src')).toBe('/plugins/call/');
    pluginFrames.leave();
    await pluginFrames.reconcile({ action: 'restart', ids: ['call'] });
    expect(frame.isConnected).toBe(false);
    expect(pluginFrames.residentIds()).toEqual([]);
    expect(h.querySelector('iframe'), 'a hidden frame is not reloaded').toBeNull();
  });

  it('reconcile reloads the resident plugin on screen in place when an evicting action ends its frame', async () => {
    const fetchMock = vi.fn(async () => ok({ state: 'ready', enabled: true, frontendKeepAlive: true }));
    vi.stubGlobal('fetch', fetchMock);
    const h = host();
    await pluginFrames.load({ id: 'call', subpath: '/x' });
    const old = h.querySelector('iframe')!;
    await pluginFrames.reconcile({ action: 'restart', ids: ['call'] });
    expect(old.isConnected, 'the renewed frame is ended').toBe(false);
    await vi.waitFor(() => expect(h.querySelector('iframe[data-plugin-id="call"]')).not.toBeNull());
    const fresh = h.querySelector<HTMLIFrameElement>('iframe[data-plugin-id="call"]')!;
    expect(fresh).not.toBe(old);
    expect(fresh.getAttribute('src'), 'reloaded at the subpath it was on').toBe('/plugins/call/x');
    expect(fresh.hidden).toBe(false);
    expect(pluginFrames.currentId()).toBe('call');
    expect(pluginFrames.residentIds()).toEqual(['call']);
    expect(overlayStore.get().overlay).toBeNull();
  });

  it('reconcile keeps a resident frame on a network blip and evicts on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ state: 'ready', enabled: true, frontendKeepAlive: true })));
    host();
    await pluginFrames.load({ id: 'call', subpath: '/' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    await pluginFrames.reconcile(undefined);
    expect(pluginFrames.residentIds()).toEqual(['call']);
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: 'unknown' }, 404)));
    await pluginFrames.reconcile(undefined);
    expect(pluginFrames.residentIds()).toEqual([]);
  });
});
