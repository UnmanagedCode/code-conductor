import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeOpenNotifications } from './notifications';

const KEY = 'code-conductor:muted-sessions';
const reload = async () => {
  vi.resetModules();
  return import('./mutes');
};

describe('summarizeOpenNotifications with exactly two pings', () => {
  it('summarises both projects, and a single ping does not', () => {
    // Invariant: two session pings yield one summary naming both projects; one ping yields none.
    const two = summarizeOpenNotifications([
      { tag: 'session:a', data: { project: 'alpha-proj' } },
      { tag: 'session:b', data: { project: 'beta-proj' } },
    ]);
    expect(two.shouldFire).toBe(true);
    if (!two.shouldFire) return;
    expect(two.body).toContain('alpha-proj');
    expect(two.body).toContain('beta-proj');
    expect(two.title).toContain('2');
    expect(summarizeOpenNotifications([{ tag: 'session:a', data: { project: 'alpha-proj' } }]).shouldFire).toBe(false);
  });
});

describe('session mutes persistence', () => {
  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => localStorage.removeItem(KEY));

  it('a mute set round-trips through localStorage across a reload', async () => {
    // Invariant: mutes written before a reload are muted after it; an unmuted id is not; clearing removes the key.
    const first = await reload();
    first.muteSession('sess-a', true);
    first.muteSession('sess-b', true);
    first.muteSession('sess-b', false);
    const second = await reload();
    expect(second.isSessionMuted('sess-a')).toBe(true);
    expect(second.isSessionMuted('sess-b')).toBe(false);
    expect(second.isSessionMuted('sess-never')).toBe(false);
    second.muteSession('sess-a', false);
    expect(localStorage.getItem(KEY)).toBeNull();
    const third = await reload();
    expect(third.isSessionMuted('sess-a')).toBe(false);
  });

  it('corrupt or absent storage restores an empty set', async () => {
    // Invariant: unreadable or missing persisted mutes mean nothing is muted, and do not throw; a valid value is the control.
    localStorage.setItem(KEY, JSON.stringify(['sess-ctl']));
    expect((await reload()).isSessionMuted('sess-ctl')).toBe(true);
    localStorage.setItem(KEY, '{not json');
    expect((await reload()).isSessionMuted('sess-ctl')).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ 'sess-ctl': true }));
    expect((await reload()).isSessionMuted('sess-ctl')).toBe(false);
    localStorage.removeItem(KEY);
    expect((await reload()).isSessionMuted('sess-ctl')).toBe(false);
  });
});
