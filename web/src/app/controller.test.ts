import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  const sent: any[] = [];
  return { bus, sent, connect: vi.fn(), send: vi.fn((t: string, payload: any) => { sent.push([t, payload]); }) };
});
vi.mock('./sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));

const M1 = 'claude-haiku-4-5';
const M2 = 'claude-opus-4-8';
const OLD_USAGE = { input_tokens: 10_000, cache_read_input_tokens: 180_000 };
const NEW_USAGE = { input_tokens: 20_000, cache_read_input_tokens: 400_000 };

let stopPrevious: (() => void) | null = null;

/** A fresh controller (module state included) over a mocked socket and REST. */
async function boot({ instances = [] as any[], locate = null as null | ((sid: string) => any) } = {}) {
  stopPrevious?.();
  vi.resetModules();
  const ws: any = await import('@shared/ws');
  ws.sent.length = 0;
  const actions: any = await import('./sessionActions');
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/instances') return { ok: true, json: async () => instances };
    if (url.startsWith('/api/sessions/') && url.endsWith('/locate')) {
      const sid = decodeURIComponent(url.split('/')[3]);
      const r = locate?.(sid);
      return r ? { ok: true, json: async () => r } : { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, json: async () => (url.includes('conductors') ? {} : []) };
  });
  vi.stubGlobal('fetch', fetch);
  const c = await import('./controller');
  const { appStore } = await import('@/state/app');
  const { getUsageTracker, getTaskTracker, rateLimits, trackerSignal } = await import('./trackers');
  const events = await import('./events');
  const selects: any[] = [];
  events.on('select', (p) => selects.push(p));
  appStore.set({ instances });
  c.startController();
  stopPrevious = c.stopController;
  const emit = (t: string, detail: any) => ws.bus.dispatchEvent(new CustomEvent(t, { detail }));
  const open = async () => { emit('open', {}); for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { c, ws, actions, fetch, appStore, getUsageTracker, getTaskTracker, rateLimits, trackerSignal, selects, emit, open };
}

beforeEach(() => {
  history.replaceState(null, '', '/');
});

describe('routing session data', () => {
  it('a snapshot replays into the active conversation, seeds trackers and mirrors the server flags', async () => {
    const b = await boot({ instances: [{ id: 'A', sessionId: 'sa', status: 'idle' }] });
    b.c.selectInstance('A');
    b.emit('snapshot', {
      id: 'A', autoApprovePlan: true, playbookEnforcement: 'warn', interrupting: false,
      lastContextUsage: OLD_USAGE, currentSegmentId: 'S1', tailSegmentId: 'S1',
      events: [{ kind: 'user_echo', text: 'hi', userIndex: 0, _seq: 1 }, { kind: 'text_delta', msgId: 'm', blockIdx: 0, text: 'yo', _seq: 2 }],
    });
    expect(b.c.conversation.items.map((i) => i.type)).toEqual(['user', 'assistant']);
    expect(b.c.conversation.currentSegmentId).toBe('S1');
    expect(b.getUsageTracker('A').currentContextSize()).toBe(190_000);
    expect(b.appStore.get().instances[0]).toMatchObject({ autoApprovePlan: true, playbookEnforcement: 'warn' });
  });

  it('a snapshot for another instance updates its trackers but never the conversation', async () => {
    const b = await boot({ instances: [{ id: 'A' }, { id: 'B' }] });
    b.c.selectInstance('A');
    b.emit('snapshot', { id: 'B', events: [{ kind: 'user_echo', text: 'other', _seq: 1 }, { kind: 'message_start', usage: NEW_USAGE, _seq: 2 }] });
    expect(b.c.conversation.items).toHaveLength(0);
    expect(b.getUsageTracker('B').currentContextSize()).toBe(420_000);
  });

  it('a snapshot replay notifies the view once, not per event', async () => {
    const b = await boot({ instances: [{ id: 'A' }] });
    b.c.selectInstance('A');
    await Promise.resolve();
    const listener = vi.fn();
    b.c.conversation.subscribe(listener);
    b.emit('snapshot', { id: 'A', events: Array.from({ length: 50 }, (_, i) => ({ kind: 'user_echo', text: `m${i}`, _seq: i + 1 })) });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a completed task batch is inserted inline at the point it completed', async () => {
    const b = await boot({ instances: [{ id: 'A' }] });
    b.c.selectInstance('A');
    b.emit('snapshot', { id: 'A', events: [
      { kind: 'tool_use', toolUseId: 't1', name: 'TaskCreate', input: { subject: 'Do it' }, _seq: 1 },
      { kind: 'tool_result', toolUseId: 't1', content: 'Task #1 created successfully: Do it', _seq: 2 },
      { kind: 'tool_use', toolUseId: 't2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, _seq: 3 },
      { kind: 'text_delta', msgId: 'm', blockIdx: 9, text: 'after', _seq: 4 },
    ] });
    // The record lands at the point the batch completed; the open envelope keeps taking text.
    expect(b.c.conversation.items.map((i) => i.type)).toEqual(['assistant', 'task_completion']);
    expect((b.c.conversation.items[1] as any).tasks.map((t: any) => t.subject)).toEqual(['Do it']);
  });

  it('R1 the live model_changed drop and a reloading client agree; context_usage and model_changed repaint the chip', async () => {
    const b = await boot({ instances: [{ id: 'A' }] });
    b.c.selectInstance('A');
    b.emit('snapshot', { id: 'A', events: [], lastContextUsage: OLD_USAGE });
    expect(b.getUsageTracker('A').currentContextSize()).toBe(190_000);
    let v = b.trackerSignal.version();
    b.emit('event', { id: 'A', ev: { kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } } });
    expect(b.trackerSignal.version()).toBeGreaterThan(v);
    const live = b.getUsageTracker('A').currentContextSize();
    b.emit('snapshot', { id: 'A', events: [], lastContextUsage: null });
    expect(b.getUsageTracker('A').currentContextSize()).toBe(live);
    v = b.trackerSignal.version();
    b.emit('event', { id: 'A', ev: { kind: 'context_usage', msgId: 'm1', usage: { input_tokens: 60_000 } } });
    expect(b.trackerSignal.version()).toBeGreaterThan(v);
  });

  it('R2 a replayed restart divider ahead of later turns keeps the seeded reading; the live one drops it', async () => {
    const b = await boot({ instances: [{ id: 'R' }] });
    b.c.selectInstance('R');
    const divider = { kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2, restart: true } };
    b.emit('snapshot', { id: 'R', lastContextUsage: NEW_USAGE, events: [{ ...divider, replayed: true, _seq: 4 }, { kind: 'user_echo', text: 'later', _seq: 5 }] });
    expect(b.getUsageTracker('R').currentContextSize()).toBe(420_000);
    b.emit('event', { id: 'R', ev: { ...divider, _seq: 7 } });
    expect(b.getUsageTracker('R').currentContextSize()).toBeNull();
  });

  it('R3 a status frame updates the instance entry, model switch fields included', async () => {
    const b = await boot({ instances: [{ id: 'S', model: M1 }] });
    const sw = { from: M1, to: M2 };
    b.emit('status', { id: 'S', status: 'turn', mode: 'plan', model: M2, sessionId: 'sid', modelSwitch: sw, modelSwitchFailure: null, interrupting: true });
    expect(b.appStore.get().instances[0]).toMatchObject({ status: 'turn', mode: 'plan', model: M2, modelSwitch: sw, interrupting: true });
  });

  it('R3 a failure frame clears the switch and reverts the model; no status frame touches a known context window (mirrors ctx-latch-model-switch R3)', async () => {
    const b = await boot({ instances: [{ id: 'S', model: M1, contextWindowTokens: 200_000 }] });
    const sw = { from: M1, to: M2 };
    b.emit('status', { id: 'S', status: 'idle', mode: 'plan', model: M2, sessionId: 's', modelSwitch: sw, modelSwitchFailure: null });
    expect(b.appStore.get().instances[0]).toMatchObject({ model: M2, modelSwitch: sw, modelSwitchFailure: null, contextWindowTokens: 200_000 });
    const failure = { ...sw, error: 'boom' };
    b.emit('status', { id: 'S', status: 'idle', mode: 'plan', model: M1, sessionId: 's', modelSwitch: null, modelSwitchFailure: failure });
    const entry = b.appStore.get().instances[0];
    expect(entry.modelSwitch).toBeNull();
    expect(entry.modelSwitchFailure).toEqual(failure);
    expect(entry.model).toBe(M1);
    expect(entry.contextWindowTokens).toBe(200_000);
  });

  it('R3b a status frame\'s backend reaches the instance entry; a frame without one leaves it (mirrors ctx-latch-model-switch R3b)', async () => {
    const b = await boot({ instances: [{ id: 'S', model: M1, backend: 'claude' }] });
    b.emit('status', { id: 'S', status: 'idle', mode: 'plan', model: 'alpha:cloud', backend: 'ollama', sessionId: 'sid', modelSwitch: null, modelSwitchFailure: null });
    expect(b.appStore.get().instances[0]).toMatchObject({ model: 'alpha:cloud', backend: 'ollama' });
    b.emit('status', { id: 'S', status: 'idle', mode: 'plan', model: 'alpha:cloud', sessionId: 'sid', modelSwitch: null, modelSwitchFailure: null });
    expect(b.appStore.get().instances[0].backend).toBe('ollama');
  });

  it('replayed history never feeds the account-wide rate-limit tracker; live events do', async () => {
    const b = await boot({ instances: [{ id: 'A' }] });
    b.rateLimits.apply({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { utilization: 0.8 } } });
    b.emit('snapshot', { id: 'A', events: [{ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { utilization: 0.1 } }, _seq: 1 }] });
    expect(b.rateLimits.info?.utilization).toBe(0.8);
    b.emit('event', { id: 'A', ev: { kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { utilization: 0.3 } } } });
    expect(b.rateLimits.info?.utilization).toBe(0.3);
  });

  it('a reset_snapshot (rewind) rebuilds the conversation and drops the prompt back into the composer', async () => {
    const b = await boot({ instances: [{ id: 'A' }] });
    const events = await import('./events');
    const prefills: string[] = [];
    events.on('prefill', ({ text }) => prefills.push(text));
    b.c.selectInstance('A');
    b.emit('snapshot', { id: 'A', events: [{ kind: 'user_echo', text: 'one', _seq: 1 }, { kind: 'user_echo', text: 'two', _seq: 2 }] });
    b.emit('reset_snapshot', { id: 'A', events: [{ kind: 'user_echo', text: 'one', _seq: 1 }], droppedText: 'two' });
    expect(b.c.conversation.items).toHaveLength(1);
    expect(prefills).toEqual(['two']);
  });

  it('a fork\'s first snapshot carries its dropped prompt; a segment frame moves the current segment', async () => {
    const b = await boot({ instances: [{ id: 'F' }] });
    const events = await import('./events');
    const prefills: string[] = [];
    events.on('prefill', ({ text }) => prefills.push(text));
    b.c.selectInstance('F');
    b.emit('snapshot', { id: 'F', events: [], droppedText: 'forked prompt' });
    expect(prefills).toEqual(['forked prompt']);
    b.emit('segment', { id: 'F', currentSegmentId: 'S9' });
    expect(b.c.conversation.currentSegmentId).toBe('S9');
  });
});

describe('selection and anchors', () => {
  it('selecting unsubscribes the previous instance, subscribes the new one and writes its session anchor', async () => {
    const b = await boot({ instances: [{ id: 'A', sessionId: 'sa' }, { id: 'B', sessionId: 'sb' }] });
    b.c.selectInstance('A');
    b.c.selectInstance('B', { userGesture: true });
    expect(b.ws.sent).toEqual([['subscribe', { id: 'A' }], ['unsubscribe', { id: 'A' }], ['subscribe', { id: 'B' }]]);
    expect(location.hash).toBe('#session=sb');
    expect(b.selects.at(-1)).toEqual({ id: 'B', sessionId: 'sb', userGesture: true });
  });

  it('first connect restores a live anchor without a user gesture and does not double-subscribe', async () => {
    history.replaceState(null, '', '/#session=s-live');
    const b = await boot({ instances: [{ id: 'live', sessionId: 's-live' }] });
    await b.open();
    expect(b.appStore.get().activeId).toBe('live');
    expect(b.selects.at(-1).userGesture).toBe(false);
    expect(b.ws.sent.filter(([t]: any) => t === 'subscribe')).toHaveLength(1);
  });

  it('first connect auto-resumes a non-archived anchored session silently, with no gesture', async () => {
    history.replaceState(null, '', '/#session=s-disk');
    const b = await boot({ locate: () => ({ project: 'p', worktreeName: 'wt', archived: false }) });
    await b.open();
    expect(b.actions.resumeSession).toHaveBeenCalledWith({ projectName: 'p', worktreeName: 'wt', sessionId: 's-disk', silent: true, userGesture: false });
  });

  it('first connect skips and clears the anchor of an archived or missing session', async () => {
    history.replaceState(null, '', '/#session=s-old');
    const b = await boot({ locate: () => ({ project: 'p', archived: true }) });
    await b.open();
    expect(b.actions.resumeSession).not.toHaveBeenCalled();
    expect(location.hash).toBe('');
    history.replaceState(null, '', '/#session=s-gone');
    const c = await boot();
    await c.open();
    expect(location.hash).toBe('');
  });

  it('popstate back to a live session anchor selects it without a gesture; a plugin hash leaves the session alone', async () => {
    const b = await boot({ instances: [{ id: 'A', sessionId: 'sa' }, { id: 'B', sessionId: 'sb' }] });
    b.c.selectInstance('A');
    history.replaceState(null, '', '/#session=sb');
    dispatchEvent(new PopStateEvent('popstate'));
    expect(b.appStore.get().activeId).toBe('B');
    expect(b.selects.at(-1).userGesture).toBe(false);
    history.replaceState(null, '', '/#plugin/demo/');
    dispatchEvent(new PopStateEvent('popstate'));
    expect(b.appStore.get().activeId).toBe('B');
  });
});

describe('notification clicks', () => {
  it('select the live instance by id, else by session, with a user gesture and no history push', async () => {
    const b = await boot({ instances: [{ id: 'inst-2', sessionId: 's2' }, { id: 'inst-3-new', sessionId: 's3' }] });
    await b.c.handleNotificationClick({ instanceId: 'inst-2', sessionId: 's2' });
    expect(b.appStore.get().activeId).toBe('inst-2');
    expect(b.selects.at(-1).userGesture).toBe(true);
    await b.c.handleNotificationClick({ instanceId: 'gone', sessionId: 's3' });
    expect(b.appStore.get().activeId).toBe('inst-3-new');
  });

  it('a reaped session is located and resumed silently with a gesture', async () => {
    const b = await boot({ locate: () => ({ project: 'p', worktreeName: null, archived: false }) });
    await b.c.handleNotificationClick({ instanceId: 'gone', sessionId: 's9' });
    expect(b.actions.resumeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's9', projectName: 'p', silent: true, userGesture: true }));
  });

  it('nothing to locate is a no-op; an unrelated archived or 404 session never clobbers the current anchor', async () => {
    const b = await boot();
    await b.c.handleNotificationClick({ instanceId: 'gone' });
    expect(b.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/locate'));
    history.replaceState(null, '', '/#session=sess-X');
    const archived = await boot({ locate: () => ({ project: 'p', archived: true }) });
    await archived.c.handleNotificationClick({ sessionId: 'other' });
    expect(location.hash).toBe('#session=sess-X');
    const missing = await boot();
    await missing.c.handleNotificationClick({ sessionId: 'other' });
    expect(location.hash).toBe('#session=sess-X');
  });
});

describe('refreshing projects', () => {
  type Conductors = { body: unknown } | 'non-ok' | 'rejected';
  let conductors: Conductors = { body: {} };

  /** A fresh controller module (not started) whose conductors fetch answers per `conductors`. */
  async function load() {
    stopPrevious?.();
    stopPrevious = null;
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/conductors/projects') {
        if (conductors === 'rejected') throw new Error('offline');
        if (conductors === 'non-ok') return { ok: false, json: async () => ({ error: 'x' }) };
        const { body } = conductors;
        return { ok: true, json: async () => body };
      }
      if (url === '/api/projects') return { ok: true, json: async () => [{ name: 'p' }] };
      return { ok: true, json: async () => [] };
    }));
    const c = await import('./controller');
    const { appStore } = await import('@/state/app');
    return { c, appStore };
  }

  it('GET /api/conductors/projects becomes appStore.conductorSpawns, the Conductors lens\'s idle-chip source', async () => {
    const body = { C: [{ project: 'p', lastSpawnAt: 1 }] };
    conductors = { body };
    const { c, appStore } = await load();
    await c.refreshProjects();
    expect(appStore.get().conductorSpawns).toEqual(body);
  });

  it('a non-ok or rejected conductors fetch replaces the spawns with an empty map', async () => {
    const body = { C: [{ project: 'p', lastSpawnAt: 1 }] };
    const { c, appStore } = await load();
    conductors = { body };
    await c.refreshProjects();
    expect(appStore.get().conductorSpawns).toEqual(body);
    conductors = 'non-ok';
    await c.refreshProjects();
    expect(appStore.get().conductorSpawns).toEqual({});

    conductors = { body };
    await c.refreshProjects();
    expect(appStore.get().conductorSpawns).toEqual(body);
    conductors = 'rejected';
    await c.refreshProjects();
    expect(appStore.get().conductorSpawns).toEqual({});
  });
});
