import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { bus } from '@shared/ws';
import { mockFetch } from '@/features/settings/test/fetchMock';
import { ResumeBanner } from './ResumeBanner';
import { resumeNoticesStore } from './store';
import { startResumeNotices } from './index';
import type { ResumeNotice } from './api';

vi.mock('@/ui/feedback', () => ({ toast: { error: vi.fn() } }));

const n = (sessionId: string, kind: ResumeNotice['kind'], title: string | null = null): ResumeNotice => ({ sessionId, kind, project: 'p', title });
const region = () => screen.queryByRole('region', { name: 'Resume sessions' });

let stop: (() => void) | null = null;
beforeEach(() => { resumeNoticesStore.set({ notices: [], busy: false }); });
afterEach(() => { stop?.(); stop = null; vi.unstubAllGlobals(); });

describe('the resume banner', () => {
  it('renders nothing when no notice is held', () => {
    // Invariant: an empty notice list shows no banner.
    render(<ResumeBanner />);
    expect(region()).toBeNull();
  });

  it('names its kind: restart, or unclean whenever any notice is unclean', () => {
    // Invariant: data-resume-kind is `unclean` if any held notice is unclean, else `restart`; each session is named.
    render(<ResumeBanner />);
    act(() => resumeNoticesStore.set({ notices: [n('a', 'restart', 'Fix login'), n('b', 'restart')] }));
    expect(region()!.dataset.resumeKind).toBe('restart');
    expect(region()!.textContent).toContain('Fix login');
    act(() => resumeNoticesStore.set({ notices: [n('a', 'restart'), n('b', 'unclean')] }));
    expect(region()!.dataset.resumeKind).toBe('unclean');
  });

  it('Continue and Dismiss post their endpoints, and are disabled while one is in flight', async () => {
    // Invariant: Continue posts /api/resume-notices/continue, Dismiss posts /api/resume-notices/dismiss; both buttons are disabled while a request runs; the list is refetched after.
    let held: ResumeNotice[] = [n('a', 'restart')];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url}`;
      calls.push(key);
      if (key === 'POST /api/resume-notices/continue') { await gate; held = []; return json({ sent: ['a'], dropped: [] }); }
      if (key === 'POST /api/resume-notices/dismiss') { held = []; return json({ dismissed: 1 }); }
      return json({ notices: held });
    }));
    act(() => resumeNoticesStore.set({ notices: held }));
    render(<ResumeBanner />);
    fireEvent.click(within(region()!).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect((within(region()!).getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(region()!).getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(region()).toBeNull());
    expect(calls).toEqual(['POST /api/resume-notices/continue', 'GET /api/resume-notices']);

    held = [n('b', 'unclean')];
    act(() => resumeNoticesStore.set({ notices: held }));
    fireEvent.click(within(region()!).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(region()).toBeNull());
    expect(calls.slice(2)).toEqual(['POST /api/resume-notices/dismiss', 'GET /api/resume-notices']);
  });

  it('fetches at start, on a resume_notices hint, and on every WebSocket open', async () => {
    // Invariant: startResumeNotices fetches once at start and again on each `resume_notices` hint and each WS `open`, so every tab follows the server.
    let held: ResumeNotice[] = [];
    const calls = mockFetch({ 'GET /api/resume-notices': () => ({ notices: held }) });
    render(<ResumeBanner />);
    stop = startResumeNotices();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(region()).toBeNull();
    held = [n('a', 'restart')];
    act(() => { bus.dispatchEvent(new CustomEvent('resume_notices', { detail: { t: 'resume_notices' } })); });
    await waitFor(() => expect(region()).not.toBeNull());
    expect(calls).toHaveLength(2);
    held = [];
    act(() => { bus.dispatchEvent(new CustomEvent('open')); });
    await waitFor(() => expect(region()).toBeNull());
    expect(calls).toHaveLength(3);
  });
});
