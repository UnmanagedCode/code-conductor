import * as React from 'react';
import { ChevronRightIcon, LoaderCircleIcon, PencilIcon } from 'lucide-react';
import { useSignal } from '@/state/createStore';
import { worktreeOwnership } from '@/lib/core/conductors.js';
import { formatAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { Instance, Project } from '@/state/types';
import { openWorkspaceDialog } from '@/features/dialogs/api';
import {
  chipsOf, filterOwner, groupProjects, hasHandSession, mergeLive, placeKeyOf, sessionSections, sessionsTotal,
  type SessionItem,
} from './derive';
import {
  ensureSessions, sessionsCache, sessionsError, sessionsSignal, sessionsStatus, setSessionsOpen, setWorkspaceOpen,
  setWorktreesOpen, useAgoTick, useSidebarUi,
} from './state';
import { Hint, IconAction, ProjectRow, SessionRow, WorktreeHead } from './rows';
import type { SidebarModel } from './useSidebarModel';

export function Chevron({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
    </button>
  );
}

export const ChevronSpacer = () => <span className="size-6 shrink-0" />;

type Ctx = { m: SidebarModel; ui: ReturnType<typeof useSidebarUi> };

/** A place's session rows: the cached disk list overlaid with live instances, narrowed by the filter. */
export function SessionsList({ ctx, project, worktreeName, liveInstances, showOwner }: {
  ctx: Ctx; project: string; worktreeName: string | null; liveInstances: Instance[]; showOwner: boolean;
}) {
  useSignal(sessionsSignal);
  const key = placeKeyOf(project, worktreeName);
  React.useEffect(() => { void ensureSessions(project, worktreeName); }, [project, worktreeName, ctx.m.cacheVersion]);
  const status = sessionsStatus(key);
  const owner = filterOwner(ctx.ui.filter);
  const rows = mergeLive(sessionsCache.get(key) ?? [], liveInstances)
    .filter((s) => (owner ? s.ownerSessionId === owner : ctx.ui.filter === 'hand' ? !s.conducted : true));
  const { normal, temp, conducted } = sessionSections(rows);
  const row = (s: SessionItem) => (
    <SessionRow
      key={s.sessionId}
      session={s}
      projectName={project}
      worktreeName={worktreeName}
      activeId={ctx.m.activeId}
      unread={ctx.m.unread.get(s.sessionId) ?? 0}
      showOwner={showOwner}
      ownerTitle={ctx.m.ownerTitle}
    />
  );
  const sep = (label: string) => (
    <li className="px-2 pt-2 pb-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground/70 uppercase">{label}</li>
  );
  return (
    <ul className="ml-3 space-y-px border-l border-sidebar-border pl-1.5" data-sessions={key}>
      {rows.length === 0 && (
        <li className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground italic">
          {status === 'loading' ? <><LoaderCircleIcon className="size-3 animate-spin" /> Loading…</>
            : status === 'error' ? `Couldn't load sessions: ${sessionsError(key)}`
            : 'No sessions'}
        </li>
      )}
      {normal.map(row)}
      {temp.length > 0 && <>{sep('Temp')}{temp.map(row)}</>}
      {conducted.length > 0 && <>{sep('Conducted')}{conducted.map(row)}</>}
    </ul>
  );
}

function SessionsMeta({ total, live, last }: { total: number; live: number; last?: number }) {
  useAgoTick();
  const text = `Sessions (${total})${live > 0 ? ` · ${live} live` : ''}${last ? ` · last ${formatAgo(last)}` : ''}`;
  return (
    <Hint label={text}>
      <span className="shrink-0 rounded-full px-1.5 text-[11px] text-muted-foreground tabular-nums" data-sessions-count>{total}</span>
    </Hint>
  );
}

function WorktreeItem({ ctx, project, wt }: { ctx: Ctx; project: Project; wt: any }) {
  const key = placeKeyOf(project.name, wt.worktreeName);
  const live = ctx.m.byWorktree.get(key) ?? [];
  const total = sessionsTotal({ key, liveInstances: live, summary: wt.sessions }, sessionsCache);
  const own = worktreeOwnership(ctx.m.owners.get(key));
  const open = !ctx.ui.collapsedSessions.includes(key);
  return (
    <li>
      <WorktreeHead
        project={project.name}
        wt={wt}
        owner={own.kind === 'single' ? own.owner : null}
        ownerTitle={ctx.m.ownerTitle}
        chevron={total > 0 ? <Chevron open={open} label="Sessions" onToggle={() => setSessionsOpen(key, !open)} /> : <ChevronSpacer />}
      />
      {total > 0 && open && (
        <SessionsList ctx={ctx} project={project.name} worktreeName={wt.worktreeName} liveInstances={live} showOwner={own.kind !== 'single'} />
      )}
    </li>
  );
}

function WorktreeGroup({ ctx, project, worktrees }: { ctx: Ctx; project: Project; worktrees: any[] }) {
  const owner = filterOwner(ctx.ui.filter);
  // A conductor filter force-opens the group without recording it as the user's choice.
  const open = owner ? true : ctx.ui.expandedWorktrees.includes(project.name);
  const listed = owner
    ? worktrees.filter((wt) => ctx.m.owners.get(placeKeyOf(project.name, wt.worktreeName))?.has(owner))
    : ctx.ui.filter === 'hand'
      ? worktrees.filter((wt) => hasHandSession({ liveInstances: ctx.m.byWorktree.get(placeKeyOf(project.name, wt.worktreeName)) ?? [], summary: wt.sessions }))
      : worktrees;
  return (
    <div className="ml-3 border-l border-sidebar-border pl-1.5" data-worktrees={project.name}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { if (!owner) setWorktreesOpen(project.name, !open); }}
        className="flex h-7 w-full items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        Worktrees ({worktrees.length})
      </button>
      {open && <ul className="space-y-px">{listed.map((wt) => <WorktreeItem key={wt.worktreeName} ctx={ctx} project={project} wt={wt} />)}</ul>}
    </div>
  );
}

export function ProjectItem({ ctx, project: p }: { ctx: Ctx; project: Project }) {
  const direct = ctx.m.directByProject.get(p.name) ?? [];
  const worktrees: any[] = Array.isArray(p.worktrees) ? p.worktrees : [];
  const owner = filterOwner(ctx.ui.filter);
  const total = sessionsTotal({ key: p.name, liveInstances: direct, summary: p.sessions }, sessionsCache);
  let showSessions = total > 0;
  let showWorktrees = worktrees.length > 0;
  if (owner) {
    showSessions = direct.some((i) => i.ownerSessionId === owner);
    showWorktrees = worktrees.some((wt) => ctx.m.owners.get(placeKeyOf(p.name, wt.worktreeName))?.has(owner));
  } else if (ctx.ui.filter === 'hand') {
    showSessions = hasHandSession({ liveInstances: direct, summary: p.sessions });
    showWorktrees = worktrees.some((wt) => hasHandSession({ liveInstances: ctx.m.byWorktree.get(placeKeyOf(p.name, wt.worktreeName)) ?? [], summary: wt.sessions }));
  }
  const open = !ctx.ui.collapsedSessions.includes(p.name);
  const allInstances = ctx.m.instances.filter((i) => i.project === p.name);
  return (
    <li data-project={p.name}>
      <ProjectRow
        project={p}
        liveCount={direct.length}
        instanceCount={allInstances.length}
        chevron={showSessions ? <Chevron open={open} label="Sessions" onToggle={() => setSessionsOpen(p.name, !open)} /> : <ChevronSpacer />}
        meta={showSessions ? <SessionsMeta total={total} live={direct.length} last={p.sessions?.lastActivity} /> : null}
      />
      {showSessions && open && <SessionsList ctx={ctx} project={p.name} worktreeName={null} liveInstances={direct} showOwner />}
      {!showSessions && worktrees.length === 0 && !owner && (
        <div className="ml-9 py-0.5 text-xs text-muted-foreground/80 italic">No sessions yet · tap + to start</div>
      )}
      {showWorktrees && <WorktreeGroup ctx={ctx} project={p} worktrees={worktrees} />}
    </li>
  );
}

export function ProjectsList({ m }: { m: SidebarModel }) {
  const ui = useSidebarUi();
  const ctx = { m, ui };
  if (m.projects.length === 0) {
    return <div className="px-3 py-6 text-center text-sm text-muted-foreground">No projects yet</div>;
  }
  const owner = filterOwner(ui.filter);
  const ownedProjects = new Set(owner ? chipsOf(owner, m.instances, m.spawns, m.registered).map((c: any) => c.project) : []);
  const hasHand = (p: Project) =>
    hasHandSession({ liveInstances: m.directByProject.get(p.name) ?? [], summary: p.sessions })
    || (Array.isArray(p.worktrees) ? p.worktrees : []).some((wt: any) =>
      hasHandSession({ liveInstances: m.byWorktree.get(placeKeyOf(p.name, wt.worktreeName)) ?? [], summary: wt.sessions }));
  const visible = (p: Project) => (owner ? ownedProjects.has(p.name) : ui.filter === 'hand' ? hasHand(p) : true);
  const { groups, unassigned } = groupProjects({ projects: m.projects, workspaces: m.workspaces, visible, filtering: !!ui.filter });
  return (
    <div className="space-y-2" data-project-list>
      {groups.map((g) => {
        const open = ui.expandedWorkspaces.includes(g.workspace);
        return (
          <section key={g.workspace} data-workspace={g.workspace}>
            <div className="group/row flex h-7 items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setWorkspaceOpen(g.workspace, !open)}
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
              >
                <ChevronRightIcon className={cn('ml-1.5 size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                <span className="truncate text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{g.workspace}</span>
                <span className="text-[11px] text-muted-foreground/70 tabular-nums">({g.count})</span>
              </button>
              <IconAction label={`Edit workspace ${g.workspace}`} onClick={() => openWorkspaceDialog(g.workspace)} className="opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">
                <PencilIcon className="size-3" />
              </IconAction>
            </div>
            {open && (
              g.members.length === 0
                ? <div className="ml-6 py-1 text-xs text-muted-foreground italic">No projects in this workspace · use the pencil to add some</div>
                : <ul className="space-y-0.5">{g.members.map((p) => <ProjectItem key={p.name} ctx={ctx} project={p} />)}</ul>
            )}
          </section>
        );
      })}
      {unassigned.length > 0 && (
        <section data-workspace="">
          {groups.length > 0 && (
            <div className="flex h-7 items-center gap-2 px-2 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">
              Other projects <span className="h-px flex-1 border-t border-dashed border-sidebar-border" />
            </div>
          )}
          <ul className="space-y-0.5">{unassigned.map((p) => <ProjectItem key={p.name} ctx={ctx} project={p} />)}</ul>
        </section>
      )}
      {groups.length === 0 && unassigned.length === 0 && (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing matches this filter</div>
      )}
    </div>
  );
}

export { chipsOf };
