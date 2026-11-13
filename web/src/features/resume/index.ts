// The resume banner's feature logic: keep resumeNoticesStore in step with the
// server's held notices — fetched at start, on every WebSocket (re)open, and on
// every `resume_notices` hint — and the banner's two actions.
import { bus } from '@shared/ws';
import { toast } from '@/ui/feedback';
import { fetchResumeNotices, postContinue, postDismiss } from './api';
import { resumeNoticesStore } from './store';

export async function refreshResumeNotices(): Promise<void> {
  try {
    const { notices } = await fetchResumeNotices();
    resumeNoticesStore.set({ notices });
  } catch { /* the next open or hint refetches */ }
}

async function act(run: () => Promise<unknown>, failure: string): Promise<void> {
  if (resumeNoticesStore.get().busy) return;
  resumeNoticesStore.set({ busy: true });
  try { await run(); }
  catch (e) { toast.error(failure, e instanceof Error ? e.message : String(e)); }
  finally {
    resumeNoticesStore.set({ busy: false });
    await refreshResumeNotices();
  }
}

/** Send each held notice to its session. */
export const continueSessions = () => act(postContinue, 'Continue failed');
/** Drop every held notice, sending none. */
export const dismissSessions = () => act(postDismiss, 'Dismiss failed');

export function startResumeNotices(): () => void {
  const ac = new AbortController();
  const refetch = () => { void refreshResumeNotices(); };
  bus.addEventListener('open', refetch, { signal: ac.signal });
  bus.addEventListener('resume_notices', refetch, { signal: ac.signal });
  refetch();
  return () => ac.abort();
}
