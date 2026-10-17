// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RL_BUCKET_KEYS } from '@shared/usage';
import { accountChanged, accountUsageStore, refreshAccountUsage } from './accountUsage';
import { rateLimits, trackerSignal } from './trackers';

const GOOD = { usage: { five_hour: { utilization: 45, resets_at: '2026-06-16T14:50:00.000Z' }, seven_day: { utilization: 38 } }, stale: false };
const reply = (body: unknown, ok = true) => vi.fn(async (_url: string, _init?: RequestInit) => ({ ok, json: async () => body }));

beforeEach(() => {
  rateLimits.reset();
  accountUsageStore.set({ usage: null, stale: false });
});

describe('account usage', () => {
  it('a good payload is stored, seeds the rate-limit tracker from the tightest bucket and repaints; fetched with no-store', async () => {
    const fetch = reply(GOOD);
    vi.stubGlobal('fetch', fetch);
    const before = trackerSignal.version();
    await refreshAccountUsage();
    expect(fetch).toHaveBeenCalledWith('/api/usage', { cache: 'no-store' });
    expect(accountUsageStore.get()).toEqual({ usage: GOOD.usage, stale: false });
    expect(rateLimits.info).toMatchObject({ rateLimitType: 'five_hour', utilization: 0.45 });
    expect(rateLimits.info!.resetsAt).toBe(new Date('2026-06-16T14:50:00.000Z').getTime() / 1000);
    expect(trackerSignal.version()).toBeGreaterThan(before);
  });

  it('a non-numeric utilization or absent reset becomes undefined', async () => {
    vi.stubGlobal('fetch', reply({ usage: { five_hour: { utilization: null } } }));
    await refreshAccountUsage();
    expect(rateLimits.info).toEqual({ rateLimitType: 'five_hour' });
  });

  it('the first present bucket in RL_BUCKET_KEYS order wins; all-null buckets apply nothing but are stored', async () => {
    const [first, , third] = RL_BUCKET_KEYS;
    vi.stubGlobal('fetch', reply({ usage: { [third]: { utilization: 90 }, [first]: { utilization: 10 } } }));
    await refreshAccountUsage();
    expect(rateLimits.info).toMatchObject({ rateLimitType: first, utilization: 0.1 });
    rateLimits.reset();
    vi.stubGlobal('fetch', reply({ usage: { five_hour: null, seven_day: null, seven_day_sonnet: { utilization: 20 } } }));
    await refreshAccountUsage();
    expect(rateLimits.info!.rateLimitType).toBe('seven_day_sonnet');
    rateLimits.reset();
    const empty = { five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null };
    vi.stubGlobal('fetch', reply({ usage: empty }));
    await refreshAccountUsage();
    expect(rateLimits.info).toBeNull();
    expect(accountUsageStore.get().usage).toEqual(empty);
  });

  it('stale mirrors the payload; a failed, null or rejected fetch keeps the last good reading', async () => {
    vi.stubGlobal('fetch', reply({ ...GOOD, stale: true }));
    await refreshAccountUsage();
    expect(accountUsageStore.get().stale).toBe(true);
    for (const f of [reply({}, false), reply({ usage: null }), vi.fn(async () => { throw new Error('offline'); })]) {
      vi.stubGlobal('fetch', f);
      await refreshAccountUsage();
      expect(accountUsageStore.get().usage).toEqual(GOOD.usage);
    }
  });

  it('a Claude login drops the old account\'s reading and tracker, refetches, and a refresh in flight is discarded', async () => {
    const releases: (() => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { releases.push(() => r({ ok: true, json: async () => GOOD })); })));
    const inFlight = refreshAccountUsage();
    rateLimits.apply({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { utilization: 0.9 } } });
    const changed = accountChanged();
    expect(accountUsageStore.get().usage).toBeNull();
    expect(rateLimits.info).toBeNull();
    releases[0]();
    await inFlight;
    expect(accountUsageStore.get().usage).toBeNull();
    releases[1]();
    await changed;
    expect(accountUsageStore.get().usage).toEqual(GOOD.usage);
  });

  it('a failed or null-usage fetch notifies nobody: no store write, no tracker repaint', async () => {
    for (const [name, f] of [['!ok', reply({}, false)], ['usage: null', reply({ usage: null })]] as const) {
      vi.stubGlobal('fetch', f);
      let writes = 0;
      const off = accountUsageStore.subscribe(() => { writes++; });
      const before = trackerSignal.version();
      await refreshAccountUsage();
      off();
      expect(f, name).toHaveBeenCalledTimes(1);
      expect(writes, `${name}: store writes`).toBe(0);
      expect(trackerSignal.version() - before, `${name}: tracker repaints`).toBe(0);
    }
  });

  it('a Claude login repaints and fetches /api/usage at once; the new account\'s bucket replaces the old one', async () => {
    vi.stubGlobal('fetch', reply(GOOD));
    await refreshAccountUsage();
    expect(rateLimits.info!.rateLimitType).toBe('five_hour');
    let release!: () => void;
    const NEXT = { usage: { seven_day: { utilization: 20 } }, stale: false };
    const fetch = vi.fn(() => new Promise((r) => { release = () => r({ ok: true, json: async () => NEXT }); }));
    vi.stubGlobal('fetch', fetch);
    const before = trackerSignal.version();
    const changed = accountChanged();
    expect(trackerSignal.version() - before).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/usage', { cache: 'no-store' });
    release();
    await changed;
    expect(rateLimits.info!.rateLimitType).toBe('seven_day');
    expect(accountUsageStore.get()).toEqual({ usage: NEXT.usage, stale: false });
  });
});
