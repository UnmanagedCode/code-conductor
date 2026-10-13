import { cn } from '@/lib/utils';

export type SessionStatus = 'running' | 'idle' | 'awaiting' | 'error' | 'stopped';

const tone: Record<SessionStatus, string> = {
  running: 'bg-success',
  idle: 'bg-muted-foreground/40',
  awaiting: 'bg-warning',
  error: 'bg-destructive',
  stopped: 'bg-transparent ring-1 ring-muted-foreground/40',
};

export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-label={status}>
      {(status === 'running' || status === 'awaiting') && (
        <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', tone[status])} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', tone[status])} />
    </span>
  );
}
