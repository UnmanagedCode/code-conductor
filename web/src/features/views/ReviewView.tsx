import * as React from 'react';
import { ChevronRightIcon, FileDiffIcon, LoaderCircleIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useStore } from '@/state/createStore';
import { cn } from '@/lib/utils';
import { apiFetch } from '@shared/http';
import { viewStore } from './api';
import { ViewMessage, ViewShell } from './ViewShell';

export type DiffFileSummary = { path: string; oldPath?: string; status?: string; adds?: number; dels?: number; binary?: boolean };
export type DiffSummary = { files?: DiffFileSummary[]; totalAdds?: number; totalDels?: number; totalFiles?: number; commitMessage?: string };
type Hunk = { header: string; lines: { type: string; content: string }[] };
type FileDetail = { hunks: Hunk[]; oversized?: boolean; truncated?: boolean; adds?: number; dels?: number; bytes?: number };

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

function Hunks({ detail }: { detail: FileDetail }) {
  if (detail.oversized) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">Diff too large to show inline (+{detail.adds} / −{detail.dels} lines). View this file locally.</div>;
  }
  return (
    <>
      <div className="overflow-x-auto font-mono text-xs leading-5">
        <div className="min-w-max">
          {detail.hunks.map((h, i) => (
            <div key={i}>
              <div className="border-y bg-info/8 px-3 py-1 text-info first:border-t-0" data-hunk-header>{h.header}</div>
              {h.lines.map((ln, j) => {
                const type = ln.type === 'add' ? 'add' : ln.type === 'del' ? 'del' : 'ctx';
                return (
                  <div key={j} className={cn('flex', type === 'add' && 'bg-success/12', type === 'del' && 'bg-destructive/10')} data-diff-line={type}>
                    <span className={cn('w-8 shrink-0 pr-2 text-right select-none text-muted-foreground/70', type === 'add' && 'text-success', type === 'del' && 'text-destructive')}>
                      {type === 'add' ? '+' : type === 'del' ? '−' : ''}
                    </span>
                    <span className="pr-4 whitespace-pre">{ln.content}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {detail.truncated && <div className="border-t px-4 py-2 text-xs text-muted-foreground">Diff truncated · showing the first part of {detail.bytes} bytes</div>}
    </>
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
      const json = await apiFetch<any>(fileDiffUrl(summaryUrl, file.path), { cache: 'no-store' });
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
            : <Hunks detail={state.detail!} />}
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

  React.useEffect(() => {
    if (!url) return;
    let live = true;
    setState({ phase: 'loading' });
    apiFetch<any>(url, { cache: 'no-store' })
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
