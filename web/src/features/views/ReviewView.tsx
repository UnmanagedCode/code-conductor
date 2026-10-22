import * as React from 'react';
import { ChevronRightIcon, Columns2Icon, FileDiffIcon, LoaderCircleIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStore } from '@/state/createStore';
import { cn } from '@/lib/utils';
import { apiFetch } from '@shared/http';
import { viewStore } from './api';
import { ViewMessage, ViewShell } from './ViewShell';
import { DiffHunks, type FileDetail } from './DiffHunks';
import { diffModeStore, setDiffMode, useDiffMode } from './diffMode';

export type DiffFileSummary = { path: string; oldPath?: string; status?: string; adds?: number; dels?: number; binary?: boolean };
export type DiffSummary = { files?: DiffFileSummary[]; totalAdds?: number; totalDels?: number; totalFiles?: number; commitMessage?: string };

/** The summary URL with `path=<file>` added: one file's hunks, fetched lazily. */
export function fileDiffUrl(summaryUrl: string, path: string) {
  const u = new URL(summaryUrl, location.href);
  u.searchParams.set('path', path);
  return u.pathname + u.search;
}

export function reviewStats(data: DiffSummary) {
  const parts: string[] = [];
  if ((data.totalAdds ?? 0) > 0) parts.push(`+${data.totalAdds}`);
  if ((data.totalDels ?? 0) > 0) parts.push(`−${data.totalDels}`);
  if (typeof data.totalFiles === 'number') parts.push(`${data.totalFiles} file${data.totalFiles === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

const STATUS: Record<string, { letter: string; cls: string; label: string }> = {
  added: { letter: 'A', cls: 'bg-success/15 text-success', label: 'Added' },
  deleted: { letter: 'D', cls: 'bg-destructive/12 text-destructive', label: 'Deleted' },
  renamed: { letter: 'R', cls: 'bg-info/15 text-info', label: 'Renamed' },
  modified: { letter: 'M', cls: 'bg-warning/15 text-warning', label: 'Modified' },
};

function DiffModeToggle() {
  const split = useStore(diffModeStore, (s) => s.mode) === 'split';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="sm" variant={split ? 'secondary' : 'ghost'} aria-pressed={split} aria-label="Split view" onClick={() => setDiffMode(split ? 'unified' : 'split')} data-diff-mode-toggle>
          <Columns2Icon /> Split
        </Button>
      </TooltipTrigger>
      <TooltipContent>{split ? 'Show diffs unified' : 'Show diffs side by side'}</TooltipContent>
    </Tooltip>
  );
}

/** One file card: collapsed by default; its hunks are fetched on first expand and cached. */
export function FileCard({ file, summaryUrl }: { file: DiffFileSummary; summaryUrl: string }) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<{ phase: 'idle' | 'loading' | 'loaded' | 'error'; detail?: FileDetail; error?: string }>({ phase: 'idle' });
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = React.useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const json = await apiFetch<any>(fileDiffUrl(summaryUrl, file.path));
      if (alive.current) setState({ phase: 'loaded', detail: json.file });
    } catch (e: any) {
      if (alive.current) setState({ phase: 'error', error: e.message });
    }
  }, [summaryUrl, file.path]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !file.binary && state.phase === 'idle') void load();
  };

  const st = STATUS[file.status ?? 'modified'] ?? STATUS.modified;
  const display = file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-review-file={file.path}>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40">
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className={cn('flex size-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold', st.cls)} title={st.label}>{st.letter}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={display}>{display}</span>
        <span className="flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
          {(file.adds ?? 0) > 0 && <span className="text-success">+{file.adds}</span>}
          {(file.dels ?? 0) > 0 && <span className="text-destructive">−{file.dels}</span>}
        </span>
      </button>
      {open && (
        <div className="border-t">
          {file.binary ? <div className="px-4 py-3 text-sm text-muted-foreground">Binary file · no text diff</div>
            : state.phase === 'loading' || state.phase === 'idle' ? <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin" />Loading diff…</div>
            : state.phase === 'error' ? (
              <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-destructive">
                Failed to load diff: {state.error}
                <Button size="sm" variant="outline" className="h-7" onClick={() => void load()}><RotateCwIcon /> Retry</Button>
              </div>
            )
            : <DiffHunks detail={state.detail!} />}
        </div>
      )}
    </div>
  );
}

/** A structured diff: a per-file summary first (safe at any size), hunks on demand. */
export function ReviewView() {
  const params = useStore(viewStore, (s) => s.review);
  const [state, setState] = React.useState<{ phase: 'loading' | 'loaded' | 'error'; data?: DiffSummary; error?: string }>({ phase: 'loading' });
  const url = params?.url ?? null;
  const { splitAvailable } = useDiffMode();

  React.useEffect(() => {
    if (!url) return;
    let live = true;
    setState({ phase: 'loading' });
    apiFetch<any>(url)
      .then((data) => live && setState({ phase: 'loaded', data }))
      .catch((e) => live && setState({ phase: 'error', error: e.message }));
    return () => { live = false; };
  }, [url]);

  const data = state.data;
  return (
    <ViewShell
      title={params?.title || 'Review changes'}
      subtitle={state.phase === 'loaded' && data ? reviewStats(data) : undefined}
      icon={<FileDiffIcon className="size-4" />}
      actions={url && splitAvailable ? <DiffModeToggle /> : undefined}
      data-view="review"
    >
      {!url ? <ViewMessage>Nothing to review. Open a diff from a worktree or a commit.</ViewMessage>
        : state.phase === 'loading' ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full rounded-xl" />)}</div>
        ) : state.phase === 'error' ? <ViewMessage tone="error">Failed to load diff: {state.error}</ViewMessage>
        : (
          <div className="space-y-3">
            {data!.commitMessage && (
              <pre className="rounded-xl border bg-muted/40 px-4 py-3 font-sans text-sm leading-relaxed whitespace-pre-wrap" data-commit-message>{data!.commitMessage}</pre>
            )}
            {!data!.files?.length ? <ViewMessage>No changes</ViewMessage>
              : data!.files.map((f) => <FileCard key={`${url}:${f.path}`} file={f} summaryUrl={url} />)}
          </div>
        )}
    </ViewShell>
  );
}
