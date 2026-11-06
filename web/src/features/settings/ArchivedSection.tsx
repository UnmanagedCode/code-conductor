import * as React from 'react';
import { ArchiveRestoreIcon, ChevronRightIcon, EyeIcon, GitBranchIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { openEndedSession, refreshInstances, refreshProjects } from '@/app/controller';
import { emit } from '@/app/events';
import { archivedSessionUrl, restoreSession } from '@/app/sessionActions';
import { useStore } from '@/state/createStore';
import { appStore, worktreeRemoved } from '@/state/app';
import { formatAgo } from '@/lib/time';
import { readablePrompt } from '@shared/promptPreview';
import { confirmDialog, toast } from '@/ui/feedback';
import { SectionIntro, Status } from './ui';
import { CONDUCT_PROJECT, CONDUCTOR_LABEL } from '@shared/conductors';
import { apiFetch } from '@shared/http';
import { json, errText } from './api';

export type ArchivedSession = { sessionId: string; title?: string | null; firstPrompt?: string | null; lastActivity?: number; size?: number; worktreeName?: string | null };
export type ArchivedGroup = { project: string; sessions: ArchivedSession[] };

/** Conductor sessions first, the rest in the server's order. */
export function orderGroups(groups: ArchivedGroup[]) {
  const list = Array.isArray(groups) ? groups.slice() : [];
  const i = list.findIndex((g) => g.project === CONDUCT_PROJECT);
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list;
}

/** The sidebar's cached per-scope session lists and the project/instance lists are stale after a restore or delete. */
function archivedChanged() {
  emit('sessionsStale', null);
  refreshProjects().catch((e) => console.warn('refreshProjects after an archive change failed:', e));
  refreshInstances().catch((e) => console.warn('refreshInstances after an archive change failed:', e));
}

export function ArchivedSection() {
  const [groups, setGroups] = React.useState<ArchivedGroup[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setGroups(orderGroups((await json<{ groups: ArchivedGroup[] }>('/api/archived')).groups));
      setError(null);
    } catch (e) {
      setError(`Failed: ${errText(e)}`);
      setGroups([]);
    }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  // Jump straight to it: resuming selects it, which leaves Settings.
  async function restore(project: string, s: ArchivedSession) {
    await restoreSession({ projectName: project, worktreeName: s.worktreeName ?? null, sessionId: s.sessionId });
    archivedChanged();
    await load();
  }

  // Read-only, from disk; selecting it leaves Settings.
  function open(project: string, s: ArchivedSession, label: string) {
    void openEndedSession({ sessionId: s.sessionId, project, worktreeName: s.worktreeName ?? null, title: label });
  }

  async function remove(project: string, s: ArchivedSession, label: string) {
    const ok = await confirmDialog({
      title: `Delete the transcript of ${label}?`,
      description: 'This permanently removes the session jsonl from disk. It cannot be undone.',
      confirmLabel: 'Delete permanently',
      destructive: true,
    });
    if (!ok) return;
    try {
      await apiFetch(archivedSessionUrl(project, s.worktreeName, s.sessionId, ''), { method: 'DELETE' });
      archivedChanged();
      await load();
    } catch (e) {
      toast.error('Delete failed', errText(e));
    }
  }

  // A session whose worktree is gone cannot resume; the projects list says which those are.
  const projects = useStore(appStore, (st) => st.projects);
  const removed = (project: string, s: ArchivedSession) => worktreeRemoved(projects, project, s.worktreeName ?? null);
  const total = (groups || []).reduce((n, g) => n + g.sessions.length, 0);

  return (
    <div className="space-y-6">
      <SectionIntro title="Archived">
        Archived sessions keep their transcript and stay resumable. Archive one with the × on a sidebar session. <strong>Open</strong> shows it read-only; <strong>Restore</strong> returns it to the sidebar and opens it; <strong>Delete</strong> permanently removes its transcript. Sessions of a deleted worktree are listed here too: they can be opened and deleted, not restored.
      </SectionIntro>
      {error ? <Status text={error} tone="error" /> : !groups ? <Status text="Loading…" /> : (
        <Status text={total > 0 ? `${total} archived session${total === 1 ? '' : 's'} across ${groups.length} project${groups.length === 1 ? '' : 's'}.` : 'No archived sessions.'} />
      )}
      <div className="space-y-3" data-testid="archived-list">
        {(groups || []).map((g) => (
          <Collapsible key={g.project} className="rounded-xl border bg-card shadow-xs" data-group={g.project}>
            <CollapsibleTrigger className="group/ag flex w-full items-center gap-2 px-4 py-3 text-left">
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/ag:rotate-90" />
              {g.project === CONDUCT_PROJECT ? <><SparklesIcon className="size-4 text-primary" /><span className="font-medium">{CONDUCTOR_LABEL}</span></> : <span className="min-w-0 font-medium break-words">{g.project}</span>}
              <span className="text-sm text-muted-foreground">({g.sessions.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="divide-y border-t">
              {g.sessions.map((s) => {
                const label = s.title || readablePrompt(s.firstPrompt) || `${s.sessionId.slice(0, 8)}…`;
                const gone = removed(g.project, s);
                return (
                  <div key={s.sessionId} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-session={s.sessionId}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm" title={label}>{label}</div>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs [overflow-wrap:anywhere] text-muted-foreground" title={s.sessionId}>
                        {s.worktreeName && <><GitBranchIcon className="size-3 shrink-0" />{s.worktreeName}{gone && <span data-worktree-removed> (worktree removed)</span>} · </>}last {formatAgo(s.lastActivity)}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => open(g.project, s, label)}><EyeIcon /> Open</Button>
                    {!gone && <Button size="sm" variant="outline" onClick={() => void restore(g.project, s)}><ArchiveRestoreIcon /> Restore</Button>}
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void remove(g.project, s, `“${label}”`)}><Trash2Icon /> Delete</Button>
                  </div>
                );
              })}
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    </div>
  );
}
