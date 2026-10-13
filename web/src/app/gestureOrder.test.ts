// Two user gestures racing to select a session: the newest gesture wins,
// whichever lands last. A notification click, a resume from the sidebar, a
// fork and the Conduct button each select only once their lookup, POST and
// list refresh are done; a session the user picks meanwhile, or a gesture
// started after them that has selected, stands over them. A gesture started
// after one that is still in flight never yields to it, and one whose own
// session is gone overtakes nothing. A fork's gesture starts when the user
// confirms it, so a click made while its confirmation is open is the older.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  const sent: [string, unknown][] = [];
  return { bus, sent, connect: vi.fn(), send: vi.fn((t: string, payload: unknown) => { sent.push([t, payload]); }) };
});
vi.mock('@/ui/feedback', () => ({
  confirmDialog: vi.fn(async () => true),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

type Inst = { id: string; sessionId: string; project: string; status: string; mode: string };
const inst = (id: string, sessionId: string): Inst => ({ id, sessionId, project: 'p', status: 'idle', mode: 'default' });
/** The instance the server answers a resume of `sessionId` with. */
const resumed = (sessionId: string): Inst => inst(`i:${sessionId}`, sessionId);
const A = inst('iA', 's-a');
const C = inst('iC', 's-c');
const L = inst('iL', 's-l');
const X = resumed('s-x');
const Y = resumed('s-y');
const Z = resumed('s-z');
const FORKED = inst('i:fork', 's-fork');
const CONDUCTOR = inst('i:cond', 's-cond');
const ON_DISK: RouteAnswer = { json: { project: 'p', worktreeName: null, archived: false } };
const MISS: RouteAnswer = { status: 404, json: {} };

type Held = ReturnType<typeof held<RouteAnswer>>;
let stop: (() => void) | null = null;

/**
 * A fresh controller (module state included) over a mocked socket, connected, with `list` as its first
 * instance list. Every later GET /api/instances, every lookup (by session id) and every POST (a resume by
 * session id, a fork as `fork`, a conductor as `conductor`) waits on its own deferred.
 */
async function boot(list: Inst[]) {
  stop?.();
  vi.resetModules();
  const ws = (await import('@shared/ws')) as unknown as { bus: EventTarget; sent: [string, unknown][] };
  ws.sent.length = 0;
  const reads: Held[] = [];
  const lookups = new Map<string, Held>();
  const posts = new Map<string, Held>();
  const hold = (m: Map<string, Held>, key: string) => { const h = held<RouteAnswer>(); m.set(key, h); return h.answer; };
  const calls = routeFetch({
    'GET /api/instances/': () => ({ json: {} }),
    'POST /api/instances/': () => hold(posts, 'fork'),
    'GET /api/instances': () => { const h = held<RouteAnswer>(); reads.push(h); return h.answer; },
    'POST /api/instances': (body) => hold(posts, body.resume ?? body.role),
    'GET /api/sessions/': (_body, url) => hold(lookups, decodeURIComponent(url.split('/')[3])),
    'GET /api/projects': () => ({ json: [] }),
    'GET /api/workspaces': () => ({ json: [] }),
  });
  const c = await import('./controller');
  const actions = await import('./sessionActions');
  const conduct = await import('@/features/dialogs/conduct');
  const { appStore, activeInstance } = await import('@/state/app');
  c.startController();
  stop = c.stopController;
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  /** Answers every instance read not answered yet with `next`, oldest first. */
  const land = async (next: Inst[]) => { for (const r of reads.splice(0)) { r.release({ json: next }); await flush(); } };
  const answer = async (m: Map<string, Held>, key: string, a: RouteAnswer) => {
    const h = m.get(key);
    if (!h) throw new Error(`fixture check: ${key} was requested`);
    m.delete(key);
    h.release(a);
    await flush();
  };
  /** Answers every resume POST still held with its session's instance, and every instance read with `next`, until none is left. */
  const drain = async (next: Inst[]) => {
    while (posts.size || reads.length) {
      for (const [key, h] of [...posts]) { posts.delete(key); h.release({ json: resumed(key) }); await flush(); }
      await land(next);
    }
  };
  ws.bus.dispatchEvent(new CustomEvent('open'));
  await flush();
  await land(list);
  return {
    c, actions, conduct, flush, land, drain,
    lookup: (sid: string, a: RouteAnswer) => answer(lookups, sid, a),
    post: (key: string, a: RouteAnswer) => answer(posts, key, a),
    pending: () => reads.length,
    active: () => activeInstance(appStore.get())?.id ?? null,
    resumes: () => calls.filter((x) => x.method === 'POST' && x.url === '/api/instances').map((x) => x.body.resume ?? x.body.role),
  };
}

beforeEach(() => { history.replaceState(null, '', '/'); });
afterEach(() => { stop?.(); stop = null; vi.restoreAllMocks(); });

describe('a gesture still in flight and a session the user picks meanwhile', () => {
  it('a session picked while a notification click looks its session up stands, with its anchor, and the clicked one is never resumed', async () => {
    const ctl = await boot([C]);
    const ctlClick = ctl.c.handleNotificationClick({ sessionId: 's-y' });
    await ctl.flush();
    await ctl.lookup('s-y', ON_DISK);
    await ctl.post('s-y', { json: Y });
    await ctl.land([C, Y]);
    await ctlClick;
    expect(ctl.active(), 'control: the click alone opens its session').toBe(Y.id);

    const b = await boot([C]);
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    b.c.selectInstance('iC', { userGesture: true });
    await b.lookup('s-y', ON_DISK);
    await b.drain([C, Y]);
    await click;
    expect(b.active()).toBe('iC');
    expect(location.hash).toBe('#session=s-c');
    expect(b.resumes()).toEqual([]);
  });

  it('a session picked while a notification click\'s resume is being POSTed stands, with its anchor', async () => {
    const b = await boot([C]);
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    expect(b.resumes(), 'fixture check: the click is resuming').toEqual(['s-y']);
    b.c.selectInstance('iC', { userGesture: true });
    await b.post('s-y', { json: Y });
    await b.land([C, Y]);
    await click;
    expect(b.active()).toBe('iC');
    expect(location.hash).toBe('#session=s-c');
  });

  it('a session picked while a notification click\'s resumed session is being listed stands, with its anchor', async () => {
    const b = await boot([C]);
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    expect(b.pending(), 'fixture check: the post-resume list read is in flight').toBe(1);
    b.c.selectInstance('iC', { userGesture: true });
    await b.land([C, Y]);
    await click;
    expect(b.active()).toBe('iC');
    expect(location.hash).toBe('#session=s-c');
  });

  it('a session picked while a notification click whose resume was refused looks for the session\'s owner stands, with its anchor', async () => {
    const own = inst('iY', 's-y');
    const ctl = await boot([C]);
    const ctlClick = ctl.c.handleNotificationClick({ sessionId: 's-y' });
    await ctl.flush();
    await ctl.lookup('s-y', ON_DISK);
    await ctl.post('s-y', { status: 409, json: { error: 'already attached' } });
    await ctl.land([C, own]);
    await ctlClick;
    expect(ctl.active(), 'control: the refused click alone opens the session\'s owner').toBe('iY');

    const b = await boot([C]);
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { status: 409, json: { error: 'already attached' } });
    expect(b.pending(), 'fixture check: the owner\'s list read is in flight').toBe(1);
    b.c.selectInstance('iC', { userGesture: true });
    await b.land([C, own]);
    await click;
    expect(b.active()).toBe('iC');
    expect(location.hash).toBe('#session=s-c');
  });

  it('a session picked before a notification click is clicked does not stop the click from opening its session', async () => {
    const b = await boot([A, C]);
    b.c.selectInstance('iC', { userGesture: true });
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([A, C, Y]);
    await click;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });

  it('a session picked while a fork is being made stands, with its anchor, and the fork is not opened', async () => {
    const ctl = await boot([A, C]);
    ctl.c.selectInstance('iA', { userGesture: true });
    const ctlFork = ctl.actions.forkActiveSession(1, 'fork me');
    await ctl.flush();
    await ctl.post('fork', { json: { instance: FORKED } });
    await ctl.land([A, C, FORKED]);
    await ctlFork;
    expect(ctl.active(), 'control: the fork alone opens the new session').toBe(FORKED.id);

    const b = await boot([A, C]);
    b.c.selectInstance('iA', { userGesture: true });
    const fork = b.actions.forkActiveSession(1, 'fork me');
    await b.flush();
    await b.post('fork', { json: { instance: FORKED } });
    expect(b.pending(), 'fixture check: the post-fork list read is in flight').toBe(1);
    b.c.selectInstance('iC', { userGesture: true });
    await b.land([A, C, FORKED]);
    await fork;
    expect(b.active()).toBe('iC');
    expect(location.hash).toBe('#session=s-c');
  });

  it('a session picked while the Conduct button\'s conductor is starting stands, with its anchor, and the conductor is not opened', async () => {
    const ctl = await boot([C]);
    const ctlStart = ctl.conduct.startConducting();
    await ctl.flush();
    await ctl.post('conductor', { json: CONDUCTOR });
    await ctl.land([C, CONDUCTOR]);
    await ctlStart;
    expect(ctl.active(), 'control: Conduct alone opens the new conductor').toBe(CONDUCTOR.id);

    const b = await boot([C]);
    const start = b.conduct.startConducting();
    await b.flush();
    expect(b.resumes(), 'fixture check: the conductor is being started').toEqual(['conductor']);
    b.c.selectInstance('iC', { userGesture: true });
    await b.post('conductor', { json: CONDUCTOR });
    await b.land([C, CONDUCTOR]);
    await start;
    expect(b.active()).toBe('iC');
    expect(location.hash).toBe('#session=s-c');
  });

  it('the active session picked again while a notification click looks its session up stands, with its anchor, and the clicked one is never resumed', async () => {
    const ctl = await boot([A, C]);
    ctl.c.selectInstance('iA', { userGesture: true });
    const ctlClick = ctl.c.handleNotificationClick({ sessionId: 's-y' });
    await ctl.flush();
    await ctl.lookup('s-y', ON_DISK);
    await ctl.post('s-y', { json: Y });
    await ctl.land([A, C, Y]);
    await ctlClick;
    expect(ctl.active(), 'control: the click opens its session over the session picked before it').toBe(Y.id);

    const b = await boot([A, C]);
    b.c.selectInstance('iA', { userGesture: true });
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    expect(b.active(), 'fixture check: the session picked again is the active one').toBe('iA');
    b.c.selectInstance('iA', { userGesture: true });
    await b.lookup('s-y', ON_DISK);
    await b.drain([A, C, Y]);
    await click;
    expect(b.active()).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
    expect(b.resumes()).toEqual([]);
  });
});

describe('two gestures in flight at once', () => {
  it('of two notification clicks, the later one opens its session when it lands first, and the earlier one landing last neither resumes nor selects over it', async () => {
    const b = await boot([C]);
    const first = b.c.handleNotificationClick({ sessionId: 's-x' });
    const later = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([C, Y]);
    await later;
    expect(b.active(), 'fixture check: the later click opened its session').toBe(Y.id);
    await b.lookup('s-x', ON_DISK);
    await b.drain([C, X, Y]);
    await first;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
    expect(b.resumes()).toEqual(['s-y']);
  });

  it('of two notification clicks, the later one opens its session when the earlier one lands first', async () => {
    const b = await boot([C]);
    const first = b.c.handleNotificationClick({ sessionId: 's-x' });
    const later = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-x', ON_DISK);
    await b.post('s-x', { json: X });
    await b.land([C, X]);
    await first;
    expect(b.active(), 'fixture check: the earlier click opened its session').toBe(X.id);
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([C, X, Y]);
    await later;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });

  it('of two notification clicks, the later one opens its session when the earlier one\'s refused resume has opened that session\'s owner first', async () => {
    const own = inst('iX', 's-x');
    const b = await boot([C]);
    const first = b.c.handleNotificationClick({ sessionId: 's-x' });
    const later = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-x', ON_DISK);
    await b.post('s-x', { status: 409, json: { error: 'already attached' } });
    await b.land([C, own]);
    await first;
    expect(b.active(), 'fixture check: the earlier click opened the session\'s owner').toBe('iX');
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([C, own, Y]);
    await later;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });

  it('a notification click on a session already in the list, made while an earlier click looks its session up, opens it, and the earlier click landing after it neither resumes nor selects over it', async () => {
    const ctl = await boot([C, L]);
    const ctlClick = ctl.c.handleNotificationClick({ sessionId: 's-x' });
    await ctl.flush();
    await ctl.lookup('s-x', ON_DISK);
    await ctl.post('s-x', { json: X });
    await ctl.land([C, L, X]);
    await ctlClick;
    expect(ctl.active(), 'control: the earlier click alone opens its session').toBe(X.id);

    const b = await boot([C, L]);
    const first = b.c.handleNotificationClick({ sessionId: 's-x' });
    await b.flush();
    await b.c.handleNotificationClick({ sessionId: 's-l' });
    expect(b.active(), 'fixture check: the later click opened the listed session').toBe('iL');
    await b.lookup('s-x', ON_DISK);
    await b.drain([C, L, X]);
    await first;
    expect(b.active()).toBe('iL');
    expect(location.hash).toBe('#session=s-l');
    expect(b.resumes()).toEqual([]);
  });

  it('a notification click made while a fork is being made opens its session when the fork lands first and opens', async () => {
    const b = await boot([A, C]);
    b.c.selectInstance('iA', { userGesture: true });
    const fork = b.actions.forkActiveSession(1, 'fork me');
    await b.flush();
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.post('fork', { json: { instance: FORKED } });
    await b.land([A, C, FORKED]);
    await fork;
    expect(b.active(), 'fixture check: the fork opened').toBe(FORKED.id);
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([A, C, FORKED, Y]);
    await click;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });

  it('a notification click made while Fork\'s confirmation is open opens its session, and the fork confirmed after it opens over it', async () => {
    const b = await boot([A, C]);
    const { confirmDialog } = await import('@/ui/feedback');
    const confirm = held<boolean>();
    vi.mocked(confirmDialog).mockImplementationOnce(() => confirm.answer);
    b.c.selectInstance('iA', { userGesture: true });
    const fork = b.actions.forkActiveSession(1, 'fork me');
    await b.flush();
    expect(vi.mocked(confirmDialog).mock.results.at(-1)?.value, 'fixture check: the fork is waiting on its confirmation').toBe(confirm.answer);
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([A, C, Y]);
    await click;
    expect(b.active(), 'fixture check: the click opened its session').toBe(Y.id);
    confirm.release(true);
    await b.flush();
    await b.post('fork', { json: { instance: FORKED } });
    await b.land([A, C, Y, FORKED]);
    await fork;
    expect(b.active()).toBe(FORKED.id);
    expect(location.hash).toBe('#session=s-fork');
  });

  it('a later notification click whose session is gone does not stop an earlier click from opening its session', async () => {
    const b = await boot([C]);
    const first = b.c.handleNotificationClick({ sessionId: 's-x' });
    const later = b.c.handleNotificationClick({ sessionId: 's-gone' });
    await b.flush();
    await b.lookup('s-gone', MISS);
    await later;
    expect(b.active(), 'fixture check: the later click selected nothing').toBeNull();
    await b.lookup('s-x', ON_DISK);
    await b.post('s-x', { json: X });
    await b.land([C, X]);
    await first;
    expect(b.active()).toBe(X.id);
    expect(location.hash).toBe('#session=s-x');
  });

  it('a notification click made while a sidebar resume runs opens its session, and the resume landing after it does not select over it', async () => {
    const b = await boot([C]);
    const row = b.actions.resumeSession({ projectName: 'p', sessionId: 's-z' });
    await b.flush();
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([C, Y]);
    await click;
    expect(b.active(), 'fixture check: the click opened its session').toBe(Y.id);
    await b.post('s-z', { json: Z });
    await b.land([C, Y, Z]);
    await row;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });

  it('a sidebar resume started while a notification click looks its session up opens its session, and the click\'s resume landing after it does not select over it', async () => {
    const b = await boot([C]);
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    const row = b.actions.resumeSession({ projectName: 'p', sessionId: 's-z' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    expect(b.resumes(), 'fixture check: the sidebar resume, then the click\'s, are both being POSTed').toEqual(['s-z', 's-y']);
    await b.post('s-z', { json: Z });
    await b.land([C, Z]);
    await row;
    expect(b.active(), 'fixture check: the sidebar resume opened its session').toBe(Z.id);
    await b.post('s-y', { json: Y });
    await b.land([C, Y, Z]);
    await click;
    expect(b.active()).toBe(Z.id);
    expect(location.hash).toBe('#session=s-z');
  });

  it('a notification click made while the Conduct button\'s conductor is starting opens its session, and the conductor landing after it is not opened', async () => {
    const b = await boot([C]);
    const start = b.conduct.startConducting();
    await b.flush();
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([C, Y]);
    await click;
    expect(b.active(), 'fixture check: the click opened its session').toBe(Y.id);
    await b.post('conductor', { json: CONDUCTOR });
    await b.land([C, Y, CONDUCTOR]);
    await start;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });

  it('a notification click made while the Conduct button\'s conductor is starting opens its session when the conductor lands first', async () => {
    const b = await boot([C]);
    const start = b.conduct.startConducting();
    await b.flush();
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    await b.post('conductor', { json: CONDUCTOR });
    await b.land([C, CONDUCTOR]);
    await start;
    expect(b.active(), 'fixture check: the conductor opened').toBe(CONDUCTOR.id);
    await b.lookup('s-y', ON_DISK);
    await b.post('s-y', { json: Y });
    await b.land([C, Y, CONDUCTOR]);
    await click;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });
});
