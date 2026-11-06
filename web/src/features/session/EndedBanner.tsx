import { PlayIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/state/createStore';
import { appStore, placeExists } from '@/state/app';
import type { Instance } from '@/state/types';
import { restoreSession } from '@/app/sessionActions';

/**
 * Above the composer of a session with no instance (Instance.ended): it says the
 * session is over, and offers Resume only while the place it ran in exists — a
 * deleted worktree's session cannot resume.
 */
export function EndedBanner({ inst }: { inst: Instance }) {
  const worktreeName = inst.ended?.worktreeName ?? null;
  const resumable = useStore(appStore, (s) => placeExists(s.projects, inst.project, worktreeName));
  const crashed = inst.status === 'crashed';
  return (
    <div
      role="status"
      data-session-ended
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/60 px-3 py-2 text-sm text-muted-foreground"
    >
      <span className="min-w-0 flex-1">
        {crashed ? 'This session crashed.' : 'This session has ended.'}
        {' '}{resumable ? 'Its transcript is read-only until you resume it.' : 'Its transcript is read-only.'}
      </span>
      {resumable && inst.sessionId && (
        <Button
          size="sm"
          onClick={() => void restoreSession({ projectName: inst.project, worktreeName, sessionId: inst.sessionId as string })}
        ><PlayIcon /> Resume</Button>
      )}
    </div>
  );
}
