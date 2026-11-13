import { HistoryIcon, TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/state/createStore';
import { resumeNoticesStore } from './store';
import { continueSessions, dismissSessions } from './index';
import type { ResumeNotice } from './api';

const nameOf = (n: ResumeNotice) => n.title || n.project || n.sessionId.slice(0, 8);

/** Offers to continue the sessions a Restart, Shut down or unexpected stop left mid-work; nothing when there are none. */
export function ResumeBanner() {
  const notices = useStore(resumeNoticesStore, (s) => s.notices);
  const busy = useStore(resumeNoticesStore, (s) => s.busy);
  if (notices.length === 0) return null;
  const kind = notices.some((n) => n.kind === 'unclean') ? 'unclean' : 'restart';
  const count = `${notices.length} session${notices.length === 1 ? ' was' : 's were'}`;
  const lead = kind === 'unclean'
    ? `cc stopped unexpectedly and has started again. ${count} cut off mid-work`
    : `cc has started again. ${count} mid-work when it stopped`;
  const Icon = kind === 'unclean' ? TriangleAlertIcon : HistoryIcon;
  return (
    <div
      role="region"
      aria-label="Resume sessions"
      data-resume-kind={kind}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/60 px-4 py-2 text-sm"
    >
      <Icon className={kind === 'unclean' ? 'size-4 shrink-0 text-warning' : 'size-4 shrink-0 text-muted-foreground'} />
      <p className="min-w-0 flex-1">
        {lead}: <span className="font-medium">{notices.map(nameOf).join(', ')}</span>. Continue tells each to pick up where it left off.
      </p>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void dismissSessions(); }}>Dismiss</Button>
        <Button size="sm" disabled={busy} onClick={() => { void continueSessions(); }}>Continue</Button>
      </div>
    </div>
  );
}
