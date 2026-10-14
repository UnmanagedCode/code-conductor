import * as React from 'react';
import { ChevronRightIcon, FoldersIcon, LayersIcon, LoaderCircleIcon, PencilIcon } from 'lucide-react';
import { useSignal } from '@/state/createStore';
import { worktreeOwnership } from '@shared/conductors';
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

/** The workspace tier: a full-width, opaque, sticky band (it bleeds over the list wrapper's px-2 in AppSidebar). */
const BAND = 'sticky top-0 z-10 -mx-2 flex h-8 items-center gap-1.5 border-y border-sidebar-border bg-sidebar-accent pr-3 pl-2';
/** Rows under a band, at the list's own left edge, with a selected row revealed clear of the band (reveal.ts scrolls `block: 'nearest'`). */
const BANDED_LIST = 'space-y-0.5 [&_[data-active]]:scroll-mt-9';

type SessionsSummary = { total: number; live: number; last?: number };
/** `<Noun> (N) · K live · last <ago>`: the Sessions list's summary. */
const summaryText = ({ total, live, last }: SessionsSummary, noun = 'Sessions') =>
  `${noun} (${total})${live > 0 ? ` · ${live} live` : ''}${last ? ` · last ${formatAgo(last)}` : ''}`;

function SummaryLine({ summary, placeKey, noun }: { summary: SessionsSummary; placeKey: string; noun: string }) {
  useAgoTick();
  return <div className="px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums" data-sessions-summary={placeKey}>{summaryText(summary, noun)}</div>;
}

/** The rail a group hangs on: sessions and worktrees nest under a project's folder. */
const RAIL = 'ml-3 border-l border-sidebar-border pl-1.5';

/** A group's fold button; the children are its label. */
function GroupToggle({ open, onToggle, label, children }: {
  open: boolean; onToggle: () => void; label?: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
      className="flex h-7 w-full items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
    >
      <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      {children}
    </button>
  );
}

/** A place's session rows: the cached disk list overlaid with live instances, narrowed by the filter. Loads only when `load`. */
function useSessionRows({ ctx, project, worktreeName, liveInstances, load }: {
  ctx: Ctx; project: string; worktreeName: string | null; liveInstances: Instance[]; load: boolean;
}) {
  useSignal(sessionsSignal);
  const key = placeKeyOf(project, worktreeName);
  React.useEffect(() => { if (load) void ensureSessions(project, worktreeName); }, [load, project, worktreeName, ctx.m.cacheVersion]);
  const status = sessionsStatus(key);
  const owner = filterOwner(ctx.ui.filter);
  const rows = mergeLive(sessionsCache.get(key) ?? [], liveInstances)
    .filter((s) => (owner ? s.ownerSessionId === owner : ctx.ui.filter === 'hand' ? !s.conducted : true));
  const { normal, temp, conducted } = sessionSections(rows);
  // One visible group goes unlabelled and the summary names it; two or more label Temp and Conducted.
  const shown = [normal, temp, conducted].filter((g) => g.length > 0).length;
  const noun = !load || shown !== 1 || normal.length > 0 ? 'Sessions' : temp.length > 0 ? 'Temp sessions' : 'Conducted sessions';
  return { key, status, rows, normal, temp, conducted, shown, noun };
}
type SessionRowsData = ReturnType<typeof useSessionRows>;

function SessionRowsList({ ctx, project, worktreeName, data, showOwner }: {
  ctx: Ctx; project: string; worktreeName: string | null; data: SessionRowsData; showOwner: boolean;
}) {
  const { key, status, rows, normal, temp, conducted, shown } = data;
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
  const label = (kind: 'temp' | 'conducted', name: string, n: number) => (
    <li className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[11px] font-normal text-muted-foreground/70" data-session-group={kind}>
      <span className="shrink-0">{name} · {n}</span>
      <span className="h-px flex-1 bg-sidebar-border" />
    </li>
  );
  return (
    <ul className="space-y-px" data-sessions={key}>
      {rows.length === 0 && (
        <li className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground italic">
          {status === 'loading' ? <><LoaderCircleIcon className="size-3 animate-spin" /> Loading…</>
            : status === 'error' ? `Couldn't load sessions: ${sessionsError(key)}`
            : 'No sessions'}
        </li>
      )}
      {normal.map(row)}
      {temp.length > 0 && <>{shown > 1 && label('temp', 'Temp', temp.length)}{temp.map(row)}</>}
      {conducted.length > 0 && <>{shown > 1 && label('conducted', 'Conducted', conducted.length)}{conducted.map(row)}</>}
    </ul>
  );
}

/** A worktree's session rows under its summary line. */
export function SessionsList({ ctx, project, worktreeName, liveInstances, showOwner, summary }: {
  ctx: Ctx; project: string; worktreeName: string | null; liveInstances: Instance[]; showOwner: boolean; summary: SessionsSummary;
}) {
  const data = useSessionRows({ ctx, project, worktreeName, liveInstances, load: true });
  return (
    <div className={RAIL}>
      <SummaryLine summary={summary} placeKey={data.key} noun={data.noun} />
      <SessionRowsList ctx={ctx} project={project} worktreeName={worktreeName} data={data} showOwner={showOwner} />
    </div>
  );
}

function SessionsLabel({ summary, placeKey, noun }: { summary: SessionsSummary; placeKey: string; noun: string }) {
  useAgoTick();
  return <span className="min-w-0 truncate tabular-nums" data-sessions-summary={placeKey}>{summaryText(summary, noun)}</span>;
}

/** A project's main-checkout sessions: a collapsible group whose header is the summary line. Open by default. */
function SessionsGroup({ ctx, project, liveInstances, summary }: {
  ctx: Ctx; project: string; liveInstances: Instance[]; summary: SessionsSummary;
}) {
  const open = !ctx.ui.collapsedSessions.includes(project);
  const data = useSessionRows({ ctx, project, worktreeName: null, liveInstances, load: open });
  const name = `${data.noun} (${summary.total})${summary.live > 0 ? ` · ${summary.live} live` : ''}`;
  return (
    <div className={RAIL} data-project-sessions={project}>
      <GroupToggle open={open} onToggle={() => setSessionsOpen(project, !open)} label={name}>
        <SessionsLabel summary={summary} placeKey={data.key} noun={data.noun} />
      </GroupToggle>
      {open && <SessionRowsList ctx={ctx} project={project} worktreeName={null} data={data} showOwner />}
    </div>
  );
}

function SessionsMeta({ summary }: { summary: SessionsSummary }) {
  useAgoTick();
  return (
    <Hint label={summaryText(summary)}>
      <span className="shrink-0 rounded-full px-1.5 text-[11px] text-muted-foreground tabular-nums" data-sessions-count>{summary.total}</span>
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
        <SessionsList
          ctx={ctx}
          project={project.name}
          worktreeName={wt.worktreeName}
          liveInstances={live}
          showOwner={own.kind !== 'single'}
          summary={{ total, live: live.length, last: wt.sessions?.lastActivity }}
        />
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
    <div className={RAIL} data-worktrees={project.name}>
      <GroupToggle open={open} onToggle={() => { if (!owner) setWorktreesOpen(project.name, !open); }}>
        Worktrees ({worktrees.length})
      </GroupToggle>
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
  const summary = { total, live: direct.length, last: p.sessions?.lastActivity };
  const allInstances = ctx.m.instances.filter((i) => i.project === p.name);
  return (
    <li data-project={p.name}>
      <ProjectRow
        project={p}
        liveCount={direct.length}
        instanceCount={allInstances.length}
        meta={showSessions ? <SessionsMeta summary={summary} /> : null}
      />
      {showSessions && <SessionsGroup ctx={ctx} project={p.name} liveInstances={direct} summary={summary} />}
      {!showSessions && worktrees.length === 0 && !owner && (
        <div className="ml-2 py-0.5 text-xs text-muted-foreground/80 italic">No sessions yet · tap + to start</div>
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
  const ownedProjects = new Set(owner ? chipsOf(owner, m.instances, m.spawns, m.registered).map((c) => c.project) : []);
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
            <div className={cn(BAND, 'group/row')} data-workspace-band={g.workspace}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setWorkspaceOpen(g.workspace, !open)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-foreground/80 hover:text-foreground"
              >
                <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" data-workspace-icon />
                <span className="truncate text-xs font-semibold tracking-wider uppercase">{g.workspace}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">({g.count})</span>
              </button>
              <IconAction label={`Edit workspace ${g.workspace}`} onClick={() => openWorkspaceDialog(g.workspace)} className="opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">
                <PencilIcon className="size-3" />
              </IconAction>
            </div>
            {open && (
              g.members.length === 0
                ? <div className="ml-6 py-1 text-xs text-muted-foreground italic">No projects in this workspace · use the pencil to add some</div>
                : <ul className={BANDED_LIST}>{g.members.map((p) => <ProjectItem key={p.name} ctx={ctx} project={p} />)}</ul>
            )}
          </section>
        );
      })}
      {unassigned.length > 0 && (
        <section data-workspace="">
          {groups.length > 0 && (
            <div className={BAND} data-workspace-band="" data-unassigned-header>
              <span className="size-3.5 shrink-0" />{/* the caret's column */}
              <FoldersIcon className="size-3.5 shrink-0 text-muted-foreground" data-workspace-icon />
              <span className="truncate text-xs font-semibold tracking-wider text-foreground/80 uppercase">Other projects</span>
            </div>
          )}
          <ul className={groups.length > 0 ? BANDED_LIST : 'space-y-0.5'}>{unassigned.map((p) => <ProjectItem key={p.name} ctx={ctx} project={p} />)}</ul>
        </section>
      )}
      {groups.length === 0 && unassigned.length === 0 && (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing matches this filter</div>
      )}
    </div>
  );
}

export { chipsOf };
