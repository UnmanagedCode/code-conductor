import * as React from 'react';
import { ArchiveRestoreIcon, ChevronRightIcon, GitBranchIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { refreshInstances, refreshProjects } from '@/app/controller';
import { emit } from '@/app/events';
import { resumeSession } from '@/app/sessionActions';
import { formatAgo } from '@/lib/time';
import { confirmDialog, toast } from '@/ui/feedback';
import { SectionIntro, Status } from './ui';
import { json, errText } from './api';

export type ArchivedSession = { sessionId: string; title?: string | null; firstPrompt?: string | null; lastActivity?: number; size?: number; worktreeName?: string | null };
export type ArchivedGroup = { project: string; sessions: ArchivedSession[] };

export function archivedSessionUrl(project: string, worktreeName: string | null | undefined, sessionId: string, suffix: string) {
  const enc = encodeURIComponent;
  const base = worktreeName
    ? `/api/projects/${enc(project)}/worktrees/${enc(worktreeName)}/sessions/${enc(sessionId)}`
    : `/api/projects/${enc(project)}/sessions/${enc(sessionId)}`;
  return base + suffix;
}

/** Conductor sessions first, the rest in the server's order. */
export function orderGroups(groups: ArchivedGroup[]) {
  const list = Array.isArray(groups) ? groups.slice() : [];
  const i = list.findIndex((g) => g.project === '.conduct');
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list;
}

/** The sidebar's cached per-scope session lists and the project/instance lists are stale after a restore or delete. */
function archivedChanged() {
  emit('sessionsStale', null);
  void refreshProjects();
  void refreshInstances();
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

  async function restore(project: string, s: ArchivedSession) {
    try {
      const r = await fetch(archivedSessionUrl(project, s.worktreeName, s.sessionId, '/restore'), { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      archivedChanged();
      await load();
      // Jump straight to it: resuming selects it, which leaves Settings.
      await resumeSession({ projectName: project, worktreeName: s.worktreeName, sessionId: s.sessionId });
    } catch (e) {
      toast.error('Restore failed', errText(e));
    }
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
      const r = await fetch(archivedSessionUrl(project, s.worktreeName, s.sessionId, ''), { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      archivedChanged();
      await load();
    } catch (e) {
      toast.error('Delete failed', errText(e));
    }
  }

  const total = (groups || []).reduce((n, g) => n + g.sessions.length, 0);

  return (
    <div className="space-y-6">
      <SectionIntro title="Archived">
        Archived sessions keep their transcript and stay resumable. Archive one with the × on a sidebar session. <strong>Restore</strong> returns it to the sidebar and opens it; <strong>Delete</strong> permanently removes its transcript.
      </SectionIntro>
      {error ? <Status text={error} tone="error" /> : !groups ? <Status text="Loading…" /> : (
        <Status text={total > 0 ? `${total} archived session${total === 1 ? '' : 's'} across ${groups.length} project${groups.length === 1 ? '' : 's'}.` : 'No archived sessions.'} />
      )}
      <div className="space-y-3" data-testid="archived-list">
        {(groups || []).map((g) => (
          <Collapsible key={g.project} className="rounded-xl border bg-card shadow-xs" data-group={g.project}>
            <CollapsibleTrigger className="group/ag flex w-full items-center gap-2 px-4 py-3 text-left">
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/ag:rotate-90" />
              {g.project === '.conduct' ? <><SparklesIcon className="size-4 text-primary" /><span className="font-medium">Conductor</span></> : <span className="min-w-0 font-medium break-all">{g.project}</span>}
              <span className="text-sm text-muted-foreground">({g.sessions.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="divide-y border-t">
              {g.sessions.map((s) => {
                const label = s.title || s.firstPrompt || `${s.sessionId.slice(0, 8)}…`;
                return (
                  <div key={s.sessionId} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-session={s.sessionId}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm" title={label}>{label}</div>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs break-all text-muted-foreground" title={s.sessionId}>
                        {s.worktreeName && <><GitBranchIcon className="size-3 shrink-0" />{s.worktreeName} · </>}last {formatAgo(s.lastActivity)}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => void restore(g.project, s)}><ArchiveRestoreIcon /> Restore</Button>
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
