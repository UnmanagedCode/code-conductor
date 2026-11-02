import * as React from 'react';
import { ChevronRightIcon, FoldersIcon, LayersIcon, LoaderCircleIcon, PencilIcon } from 'lucide-react';
import { useSignal } from '@/state/createStore';
import { worktreeOwnership } from '@shared/conductors';
import { formatAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { Instance, Project, Worktree } from '@/state/types';
import { openWorkspaceDialog } from '@/features/dialogs/api';
import { Button } from '@/components/ui/button';
import {
  chipsOf, filterOwner, filterProjects, groupProjects, mergeLive, placeKeyOf, scopeSessionRows, scopeShowsMain, scopeShowsProject,
  scopeWorktrees, sessionSections, sessionsTotal, type ScopeCtx, type SessionItem,
} from './derive';
import {
  ensureSessions, sessionsCache, sessionsError, sessionsSignal, sessionsStatus, setSessionsOpen, setWorkspaceOpen,
  setWorktreesOpen, useAgoTick, useSidebarUi,
} from './state';
import { Hint, IconAction, ProjectRow, SessionRow, WorktreeHead } from './rows';
import { Highlight } from './Highlight';
import { heldRowsOf, searchCovers, useSearchPending, useSearchVersion } from './sessionSearch';
import { searchTree, tokensOf, type ProjectMatch, type TreeMatch } from './textFilter';
import { clearQuery, toggleForced, useTextFilter } from './textFilterState';
import { ProjectMenu } from './ProjectMenu';
import { WorktreeMenu } from './WorktreeMenu';
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

type Ctx = { m: SidebarModel; ui: ReturnType<typeof useSidebarUi>; tf: TextFilter };

/** The text filter as the tree reads it: inactive, or the classification of the tree plus the rows each narrowed place keeps. */
type TextFilter = {
  active: boolean;
  query: string;
  tokens: string[];
  match: TreeMatch | null;
  /** Narrowed place key → its matching rows. A place absent here shows all its rows. */
  hits: Map<string, SessionItem[]>;
  collapsed: string[];
};

const scopeOf = (m: SidebarModel, ui: { filter: string }): ScopeCtx => ({ filter: ui.filter, owners: m.owners, byWorktree: m.byWorktree });

/** The scope-visible, non-archived rows of a place, from the cache or what the search holds, with live instances overlaid. */
function placeRows(m: SidebarModel, filter: string, project: string, worktree: string | null): SessionItem[] {
  const key = placeKeyOf(project, worktree);
  const live = (worktree ? m.byWorktree.get(key) : m.directByProject.get(project)) ?? [];
  return scopeSessionRows(mergeLive(sessionsCache.get(key) ?? heldRowsOf(key) ?? [], live), filter).filter((s) => !s.archived);
}

function useProjectsTextFilter(m: SidebarModel, ui: { filter: string }): TextFilter {
  const { query, collapsed } = useTextFilter();
  const version = useSearchVersion();
  const tokens = React.useMemo(() => tokensOf(query), [query]);
  return React.useMemo(() => {
    if (tokens.length === 0) return { active: false, query, tokens, match: null, hits: new Map(), collapsed };
    const scope = scopeOf(m, ui);
    const owner = filterOwner(ui.filter);
    const ownedProjects = owner ? filterProjects(owner, m.instances, m.spawns, m.registered) : new Set<string>();
    const directOf = (p: Project) => m.directByProject.get(p.name) ?? [];
    const worktreesOf = (p: Project): Worktree[] => (Array.isArray(p.worktrees) ? p.worktrees : []);
    const match = searchTree({
      tokens,
      projects: m.projects,
      workspaces: m.workspaces,
      showsProject: (p) => scopeShowsProject({ ...scope, project: p, direct: directOf(p), ownedProjects }),
      mainShown: (p) => scopeShowsMain({ ...scope, project: p, direct: directOf(p), total: sessionsTotal({ key: p.name, liveInstances: directOf(p), summary: p.sessions }, sessionsCache) }).sessions,
      worktreesOf: (p) => scopeWorktrees({ ...scope, project: p, worktrees: worktreesOf(p) }),
      rowsOf: (project, worktree) => placeRows(m, ui.filter, project, worktree),
    });
    const hits = new Map<string, SessionItem[]>();
    const keep = (project: string, worktree: string | null, ids: Set<string>) =>
      hits.set(placeKeyOf(project, worktree), placeRows(m, ui.filter, project, worktree).filter((r) => ids.has(r.sessionId)));
    for (const [name, pm] of match.projects) {
      if (pm.kind !== 'narrowed') continue;
      if (pm.main) keep(name, null, pm.main);
      for (const [wt, hit] of pm.worktrees) if (hit.kind === 'narrowed') keep(name, wt, hit.sessions);
    }
    return { active: true, query, tokens, match, hits, collapsed };
    // `version`: the search's held rows changed.
  }, [tokens, query, collapsed, m, ui.filter, m.cacheVersion, version]);
}

/** A group's open state: the user's, or while the filter has force-opened it, its own transient one. */
const openUnder = (tf: TextFilter, key: string, forced: boolean, userOpen: boolean) => (tf.active && forced ? !tf.collapsed.includes(key) : userOpen);
/** A group's fold action: the filter's transient toggle for a force-opened group, else the user's. */
const foldUnder = (tf: TextFilter, key: string, forced: boolean, user: () => void) => () => { if (tf.active && forced) toggleForced(key); else user(); };

/** A narrowed place's summary, from its matching rows only. */
const hitSummary = (rows: SessionItem[]): SessionsSummary => ({
  total: rows.length,
  live: rows.filter((r) => r.instanceId).length,
  last: rows.reduce((max, r) => Math.max(max, r.lastActivity ?? 0), 0) || undefined,
});

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
  // While the text filter holds this place's list (under its current fingerprint) the tree need not fetch it again.
  const covered = ctx.tf.active && searchCovers(key);
  React.useEffect(() => { if (load && !covered) void ensureSessions(project, worktreeName); }, [load, covered, project, worktreeName, ctx.m.cacheVersion]);
  const status = sessionsStatus(key);
  const narrowTo = ctx.tf.hits.get(key);
  const narrowIds = narrowTo ? new Set(narrowTo.map((r) => r.sessionId)) : null;
  const rows = scopeSessionRows(mergeLive(sessionsCache.get(key) ?? (ctx.tf.active ? heldRowsOf(key) : null) ?? [], liveInstances), ctx.ui.filter)
    .filter((s) => !narrowIds || narrowIds.has(s.sessionId));
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
      owner={showOwner ? ctx.m.rowOwner(s) : null}
      ownerTitle={ctx.m.ownerTitle}
      highlight={ctx.tf.active ? ctx.tf.tokens : undefined}
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
  const forced = !!ctx.tf.match?.forced.sessions.has(project);
  const open = openUnder(ctx.tf, `s:${project}`, forced, !ctx.ui.collapsedSessions.includes(project));
  const data = useSessionRows({ ctx, project, worktreeName: null, liveInstances, load: open });
  const name = `${data.noun} (${summary.total})${summary.live > 0 ? ` · ${summary.live} live` : ''}`;
  return (
    <div className={RAIL} data-project-sessions={project}>
      <GroupToggle open={open} onToggle={foldUnder(ctx.tf, `s:${project}`, forced, () => setSessionsOpen(project, !open))} label={name}>
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
  const narrowed = ctx.tf.hits.get(key);
  const total = narrowed ? narrowed.length : sessionsTotal({ key, liveInstances: live, summary: wt.sessions }, sessionsCache);
  const own = worktreeOwnership(ctx.m.barOwners.get(key));
  const forced = !!ctx.tf.match?.forced.sessions.has(key);
  const open = openUnder(ctx.tf, `s:${key}`, forced, !ctx.ui.collapsedSessions.includes(key));
  const toggle = foldUnder(ctx.tf, `s:${key}`, forced, () => setSessionsOpen(key, !open));
  return (
    <li>
      <WorktreeHead
        project={project.name}
        wt={wt}
        owner={own.kind === 'single' ? own.owner : null}
        ownerTitle={ctx.m.ownerTitle}
        chevron={total > 0 ? <Chevron open={open} label="Sessions" onToggle={toggle} /> : <ChevronSpacer />}
        menu={<WorktreeMenu project={project} worktree={wt.worktreeName} />}
        highlight={ctx.tf.active ? ctx.tf.tokens : undefined}
      />
      {total > 0 && open && (
        <SessionsList
          ctx={ctx}
          project={project.name}
          worktreeName={wt.worktreeName}
          liveInstances={live}
          showOwner={own.kind !== 'single'}
          summary={narrowed ? hitSummary(narrowed) : { total, live: live.length, last: wt.sessions?.lastActivity }}
        />
      )}
    </li>
  );
}

function WorktreeGroup({ ctx, project, worktrees, match }: { ctx: Ctx; project: Project; worktrees: any[]; match?: ProjectMatch }) {
  const owner = filterOwner(ctx.ui.filter);
  const forced = !!ctx.tf.match?.forced.worktreeGroups.has(project.name);
  // A conductor filter force-opens the group without recording it as the user's choice.
  const open = owner ? true : openUnder(ctx.tf, `wt:${project.name}`, forced, ctx.ui.expandedWorktrees.includes(project.name));
  const scoped = scopeWorktrees({ ...scopeOf(ctx.m, ctx.ui), project, worktrees });
  const listed = match?.kind === 'narrowed' ? scoped.filter((wt) => match.worktrees.has(wt.worktreeName)) : scoped;
  const toggle = foldUnder(ctx.tf, `wt:${project.name}`, forced, () => setWorktreesOpen(project.name, !open));
  return (
    <div className={RAIL} data-worktrees={project.name}>
      <GroupToggle open={open} onToggle={() => { if (!owner) toggle(); }}>
        Worktrees ({ctx.tf.active ? listed.length : worktrees.length})
      </GroupToggle>
      {open && <ul className="space-y-px">{listed.map((wt) => <WorktreeItem key={wt.worktreeName} ctx={ctx} project={project} wt={wt} />)}</ul>}
    </div>
  );
}

export function ProjectItem({ ctx, project: p }: { ctx: Ctx; project: Project }) {
  const direct = ctx.m.directByProject.get(p.name) ?? [];
  const worktrees: any[] = Array.isArray(p.worktrees) ? p.worktrees : [];
  const owner = filterOwner(ctx.ui.filter);
  const pm = ctx.tf.match?.projects.get(p.name);
  const narrowed = pm?.kind === 'narrowed' ? pm : null;
  const mainHits = ctx.tf.hits.get(p.name);
  const total = narrowed ? (mainHits?.length ?? 0) : sessionsTotal({ key: p.name, liveInstances: direct, summary: p.sessions }, sessionsCache);
  const shown = scopeShowsMain({ ...scopeOf(ctx.m, ctx.ui), project: p, direct, total });
  const showSessions = narrowed ? !!narrowed.main : shown.sessions;
  const showWorktrees = narrowed ? narrowed.worktrees.size > 0 : shown.worktrees;
  const summary = narrowed && mainHits ? hitSummary(mainHits) : { total, live: direct.length, last: p.sessions?.lastActivity };
  const allInstances = ctx.m.instances.filter((i) => i.project === p.name);
  return (
    <li data-project={p.name}>
      <ProjectRow
        project={p}
        liveCount={direct.length}
        meta={showSessions ? <SessionsMeta summary={summary} /> : null}
        menu={<ProjectMenu project={p} instanceCount={allInstances.length} />}
        highlight={ctx.tf.active ? ctx.tf.tokens : undefined}
      />
      {showSessions && <SessionsGroup ctx={ctx} project={p.name} liveInstances={direct} summary={summary} />}
      {!showSessions && worktrees.length === 0 && !owner && !narrowed && (
        <div className="ml-2 py-0.5 text-xs text-muted-foreground italic">No sessions yet · start one from ⋮</div>
      )}
      {showWorktrees && <WorktreeGroup ctx={ctx} project={p} worktrees={worktrees} match={pm} />}
    </li>
  );
}

export function ProjectsList({ m }: { m: SidebarModel }) {
  const ui = useSidebarUi();
  const tf = useProjectsTextFilter(m, ui);
  const searching = useSearchPending();
  const ctx = { m, ui, tf };
  if (m.projects.length === 0) {
    return <div className="px-3 py-6 text-center text-sm text-muted-foreground">No projects yet</div>;
  }
  const owner = filterOwner(ui.filter);
  const ownedProjects = owner ? filterProjects(owner, m.instances, m.spawns, m.registered) : new Set<string>();
  const scope = scopeOf(m, ui);
  const visible = (p: Project) => (tf.match
    ? tf.match.projects.has(p.name)
    : scopeShowsProject({ ...scope, project: p, direct: m.directByProject.get(p.name) ?? [], ownedProjects }));
  const { groups, unassigned } = groupProjects({
    projects: m.projects, workspaces: m.workspaces, visible, filtering: !!ui.filter || tf.active,
    keep: (w) => !ui.filter && !!tf.match?.workspaces.has(w),
  });
  const hl = tf.active ? tf.tokens : undefined;
  return (
    <div className="space-y-2" data-project-list>
      {searching && tf.active && (
        <div role="status" data-filter-pending className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3 animate-spin" /> Searching sessions…
        </div>
      )}
      {groups.map((g) => {
        const forced = !!tf.match?.forced.workspaces.has(g.workspace);
        const open = openUnder(tf, `ws:${g.workspace}`, forced, ui.expandedWorkspaces.includes(g.workspace));
        const toggle = foldUnder(tf, `ws:${g.workspace}`, forced, () => setWorkspaceOpen(g.workspace, !open));
        return (
          <section key={g.workspace} data-workspace={g.workspace}>
            <div className={cn(BAND, 'group/row')} data-workspace-band={g.workspace}>
              <button
                type="button"
                aria-expanded={open}
                onClick={toggle}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-foreground/80 hover:text-foreground"
              >
                <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" data-workspace-icon />
                <span className="truncate text-xs font-semibold tracking-wider uppercase"><Highlight text={g.workspace} tokens={hl} /></span>
                <span className="text-[11px] text-muted-foreground tabular-nums">({tf.active ? g.members.length : g.count})</span>
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
      {groups.length === 0 && unassigned.length === 0 && (tf.active ? (
        <div data-filter-empty className="flex flex-col items-center gap-2 px-3 py-4 text-center text-xs text-muted-foreground">
          <span>No matches for '{tf.query.trim()}'</span>
          <Button variant="outline" size="sm" onClick={clearQuery}>Clear filter</Button>
        </div>
      ) : (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing matches this filter</div>
      ))}
    </div>
  );
}

export { chipsOf };
