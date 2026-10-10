import * as React from 'react';
import { GitCommitHorizontalIcon, GitMergeIcon, GitPullRequestArrowIcon, LockIcon, LockOpenIcon, PencilLineIcon, ArrowDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStore } from '@/state/createStore';
import { themeStore } from '@/app/theme';
import { mergeWorktree, setWorktreeLock, syncWorktree, type WorktreeTarget } from '@/app/sessionActions';
import { cn } from '@/lib/utils';
import { openReview, viewStore } from './api';
import { ViewMessage, ViewShell } from './ViewShell';
import { BAND_H, DOT_CY, DOT_R, LANE_W, computeGraph, laneColor, laneEmanates, laneX, type GraphRow } from './graph';
import { commitDiffUrl, commitsApiBase, commitsStats, dividerIndex, uncommittedDiffUrl, type Commit, type CommitsPayload } from './commitsModel';

/** One row's slice of the rail: a fixed-height SVG node band plus full-height filler lines. */
export function CommitRail({ layout, maxCols, node = true, uncommitted = false, fromWorkingTree = false }: { layout: GraphRow | null; maxCols: number; node?: boolean; uncommitted?: boolean; fromWorkingTree?: boolean }) {
  const dark = useStore(themeStore, (s) => s.resolved === 'dark');
  const width = Math.max(maxCols, 1) * LANE_W;
  if (!layout) return <div className="relative shrink-0 self-stretch" style={{ width }} aria-hidden />;
  const { sha, col, lanesBefore, lanesAfter } = layout;
  const cx = laneX(col);
  const color = (k: number) => laneColor(k, dark);
  const lines: React.ReactNode[] = [];
  // HEAD's row: the working-tree lane above comes down into this dot.
  if (fromWorkingTree) lines.push(<line key="wt" x1={cx} y1={0} x2={cx} y2={DOT_CY} stroke="var(--warning)" strokeWidth={2} strokeLinecap="round" strokeDasharray="3 3" />);
  lanesBefore.forEach((target, k) => {
    if (target == null) return;
    const x = laneX(k);
    lines.push(<line key={`i${k}`} x1={x} y1={0} x2={target === sha ? cx : x} y2={DOT_CY} stroke={color(k)} strokeWidth={2} strokeLinecap="round" />);
  });
  lanesAfter.forEach((target, k) => {
    if (target == null) return;
    const x = laneX(k);
    const from = laneEmanates(k, col, lanesBefore, sha) ? cx : x;
    lines.push(<line key={`o${k}`} x1={from} y1={DOT_CY} x2={x} y2={BAND_H} stroke={uncommitted ? 'var(--warning)' : color(k)} strokeWidth={2} strokeLinecap="round" strokeDasharray={uncommitted ? '3 3' : undefined} />);
  });
  return (
    <div className="relative shrink-0 self-stretch" style={{ width }} aria-hidden data-rail>
      <svg width={width} height={BAND_H} className="absolute top-0 left-0 overflow-visible">
        {lines}
        {node && (uncommitted
          ? <circle cx={cx} cy={DOT_CY} r={DOT_R} fill="var(--card)" stroke="var(--warning)" strokeWidth={2} />
          : <circle cx={cx} cy={DOT_CY} r={DOT_R} fill={color(col)} stroke="var(--card)" strokeWidth={1.5} />)}
      </svg>
      <div className="absolute right-0 bottom-0 left-0" style={{ top: BAND_H }}>
        {lanesAfter.map((target, k) => target == null ? null : (
          <div key={k} className="absolute top-0 bottom-0 w-0.5" style={{ left: laneX(k) - 1, background: uncommitted ? 'var(--warning)' : color(k) }} />
        ))}
      </div>
    </div>
  );
}

/** Straight lane lines through a non-commit row (the ahead divider), so lanes don't break. */
function LanePass({ lanes, maxCols }: { lanes: (string | null)[]; maxCols: number }) {
  const dark = useStore(themeStore, (s) => s.resolved === 'dark');
  return (
    <div className="relative shrink-0 self-stretch" style={{ width: Math.max(maxCols, 1) * LANE_W }} aria-hidden>
      {lanes.map((t, k) => t == null ? null : (
        <div key={k} className="absolute top-0 bottom-0 w-0.5" style={{ left: laneX(k) - 1, background: laneColor(k, dark) }} />
      ))}
    </div>
  );
}

export function CommitList({ data, apiBase, onOpen }: {
  data: CommitsPayload;
  apiBase: string;
  onOpen: (c: { sha: string | null; shortSha: string | null; subject: string; diffUrl: string }) => void;
}) {
  const commits = data.commits ?? [];
  const { rows, maxCols } = React.useMemo(() => computeGraph(commits), [commits]);
  const divider = dividerIndex(data);
  const uncommittedRow = data.hasUncommitted && (
    <button
      type="button"
      className="flex w-full items-stretch gap-3 bg-warning/6 px-3 text-left hover:bg-warning/12"
      onClick={() => onOpen({ sha: null, shortSha: null, subject: 'Working tree (uncommitted)', diffUrl: uncommittedDiffUrl(apiBase) })}
      data-commit-row="uncommitted"
    >
      {commits.length > 0 && rows[0] && (
        <CommitRail
          layout={{ sha: null, col: rows[0].col, lanesBefore: [], lanesAfter: Array.from({ length: rows[0].col + 1 }, (_, k) => (k === rows[0].col ? 'WORKING_TREE' : null)) }}
          maxCols={maxCols}
          uncommitted
        />
      )}
      <span className="flex items-center gap-2 py-2.5 text-sm font-medium text-warning"><PencilLineIcon className="size-4" /> Working tree <span className="font-normal opacity-80">· uncommitted changes</span></span>
    </button>
  );
  if (!commits.length) {
    return <div className="space-y-3">{uncommittedRow && <div className="overflow-hidden rounded-xl border">{uncommittedRow}</div>}<ViewMessage>No commits</ViewMessage></div>;
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-commit-list>
      {uncommittedRow}
      {commits.map((c: Commit, i: number) => (
        <React.Fragment key={c.sha}>
          {i === divider && (
            <div className="flex items-stretch gap-3 border-t bg-muted/40 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase" data-ahead-divider>
              {maxCols > 0 && <LanePass lanes={rows[i - 1]?.lanesAfter ?? []} maxCols={maxCols} />}
              <span className="flex items-center gap-1.5 py-1.5"><ArrowDownIcon className="size-3" /> Already in {data.aheadOf}</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => onOpen({ ...c, diffUrl: commitDiffUrl(apiBase, c.sha) })}
            className={cn(
              'flex w-full items-stretch gap-3 px-3 text-left transition-colors hover:bg-muted/50',
              c.ahead === true && 'bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]',
            )}
            data-commit-row={c.sha}
            data-ahead={c.ahead === true ? 'true' : undefined}
          >
            {maxCols > 0 && <CommitRail layout={rows[i]} maxCols={maxCols} fromWorkingTree={i === 0 && !!data.hasUncommitted} />}
            <span className="min-w-0 flex-1 py-2">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.shortSha}</span>
                <span className="truncate text-sm font-medium" title={c.subject}>{c.subject}</span>
              </span>
              <span className="mt-0.5 flex gap-2 text-xs text-muted-foreground">
                {c.author && <span className="truncate">{c.author}</span>}
                {c.relativeDate && <span className="shrink-0">{c.relativeDate}</span>}
              </span>
            </span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

/** A project's (or a worktree checkout's) commit history, with Sync / Merge / Lock for a worktree. */
export function CommitsView() {
  const params = useStore(viewStore, (s) => s.commits);
  const project = params?.project ?? null;
  const worktree = params?.worktree ?? null;
  const apiBase = project ? commitsApiBase(project, worktree) : '';
  const [state, setState] = React.useState<{ phase: 'loading' | 'loaded' | 'error'; data?: CommitsPayload; error?: string }>({ phase: 'loading' });
  const [locked, setLocked] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  // The target on screen now: results landing after the view moved on are dropped.
  const target = React.useRef<WorktreeTarget | null>(null);
  target.current = project && worktree ? { project, worktree } : null;
  const loadSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!project) return;
    const seq = ++loadSeq.current;
    setState((s) => (s.phase === 'loaded' ? s : { phase: 'loading' }));
    try {
      const res = await fetch(`${apiBase}/commits`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: CommitsPayload = await res.json();
      if (seq !== loadSeq.current) return;
      if (worktree) setLocked(data.locked === true);
      setState({ phase: 'loaded', data });
    } catch (e: any) {
      if (seq === loadSeq.current) setState({ phase: 'error', error: e.message });
    }
  }, [project, worktree, apiBase]);

  React.useEffect(() => {
    setLocked(null);
    setState({ phase: 'loading' });
    void load();
  }, [load]);

  async function run(action: (t: WorktreeTarget) => Promise<any>, onOk: (r: any) => void | Promise<void> = () => load()) {
    const t = target.current;
    if (!t) return;
    setBusy(true);
    try {
      const result = await action(t);
      const same = target.current && target.current.project === t.project && target.current.worktree === t.worktree;
      if (result?.ok && same) await onOk(result);
    } finally {
      setBusy(false);
    }
  }

  const subject = worktree || project || 'Commit history';
  const data = state.data;
  const isLocked = locked === true;
  const actions = worktree ? (
    <>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(syncWorktree)} title="Bring this worktree up to date with its parent branch">
        <GitPullRequestArrowIcon /> <span className="hidden sm:inline">Sync</span>
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button size="sm" variant="outline" disabled={busy || isLocked} onClick={() => void run(mergeWorktree)}>
              <GitMergeIcon /> <span className="hidden sm:inline">Merge</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{isLocked ? 'Locked against merging into its base. Unlock to merge.' : "Merge this worktree's branch into its parent"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant={isLocked ? 'secondary' : 'ghost'}
            disabled={busy || locked === null}
            aria-pressed={isLocked}
            onClick={() => void run((t) => setWorktreeLock(t, !isLocked), (r) => setLocked(r.locked === true))}
          >
            {isLocked ? <LockIcon /> : <LockOpenIcon />} <span className="hidden sm:inline">{isLocked ? 'Locked' : 'Lock'}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          {isLocked ? 'Locked against merging and against deletion by agents. Click to unlock.'
            : 'Lock against merging into its base and against deletion by agents. Sync and your own delete still work.'}
        </TooltipContent>
      </Tooltip>
    </>
  ) : undefined;

  return (
    <ViewShell
      title={data?.branch ? <>{subject} <span className="font-normal text-muted-foreground">· {data.branch}</span></> : subject}
      subtitle={data ? commitsStats(data) : undefined}
      icon={<GitCommitHorizontalIcon className="size-4" />}
      actions={actions}
      data-view="commits"
    >
      {!project ? <ViewMessage>No project selected. Open the history from a project or worktree in the sidebar.</ViewMessage>
        : state.phase === 'loading' ? <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        : state.phase === 'error' ? <ViewMessage tone="error">Failed to load commits: {state.error}</ViewMessage>
        : (
          <CommitList
            data={data!}
            apiBase={apiBase}
            onOpen={(c) => openReview({ title: c.sha ? `${c.shortSha} ${c.subject}` : c.subject, url: c.diffUrl })}
          />
        )}
    </ViewShell>
  );
}
