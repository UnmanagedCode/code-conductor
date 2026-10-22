import { cn } from '@/lib/utils';
import { lineType, splitRows, type DiffHunk, type SplitCell } from '@shared/diffSplit';
import { useDiffMode } from './diffMode';

export type FileDetail = { hunks: DiffHunk[]; oversized?: boolean; truncated?: boolean; adds?: number; dels?: number; bytes?: number };

const HEADER_CLS = 'border-y bg-info/8 px-3 py-1 text-info first:border-t-0';

function UnifiedHunks({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="overflow-x-auto font-mono text-xs leading-5" data-diff-mode="unified">
      <div className="min-w-max">
        {hunks.map((h, i) => (
          <div key={i}>
            <div className={HEADER_CLS} data-hunk-header>{h.header}</div>
            {h.lines.map((ln, j) => {
              const type = lineType(ln.type);
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
  );
}

const TONE = { del: 'bg-destructive/10', add: 'bg-success/12', empty: 'bg-muted/40', ctx: '' } as const;

/** One side of a split row: a line-number cell and a wrapping text cell, both toned by the line's type. */
function Side({ side, cell }: { side: 'old' | 'new'; cell: SplitCell | null }) {
  const kind = cell?.type ?? 'empty';
  return (
    <>
      <span
        className={cn('select-none px-2 text-right tabular-nums text-muted-foreground/70', TONE[kind], kind === 'del' && 'text-destructive', kind === 'add' && 'text-success', side === 'new' && 'border-l')}
        data-line-num={side}
      >
        {cell?.num ?? ''}
      </span>
      <span className={cn('min-h-5 whitespace-pre-wrap pr-3 [overflow-wrap:anywhere]', TONE[kind])} data-split-cell={side} data-cell-type={kind}>
        {cell?.content ?? ''}
      </span>
    </>
  );
}

function SplitHunks({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="font-mono text-xs leading-5" data-diff-mode="split">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        {hunks.map((h, i) => (
          <HunkRows key={i} hunk={h} />
        ))}
      </div>
    </div>
  );
}

function HunkRows({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      <div className={cn(HEADER_CLS, 'col-span-4 border-t-0 [overflow-wrap:anywhere]')} data-hunk-header>{hunk.header}</div>
      {splitRows(hunk).map((r, j) => (
        <div key={j} className="contents" data-split-row>
          <Side side="old" cell={r.left} />
          <Side side="new" cell={r.right} />
        </div>
      ))}
    </>
  );
}

/** One file's hunks in the chosen layout; the oversized and truncated notes are the same in both. */
export function DiffHunks({ detail }: { detail: FileDetail }) {
  const { mode } = useDiffMode();
  if (detail.oversized) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">Diff too large to show inline (+{detail.adds} / −{detail.dels} lines). View this file locally.</div>;
  }
  return (
    <>
      {mode === 'split' ? <SplitHunks hunks={detail.hunks} /> : <UnifiedHunks hunks={detail.hunks} />}
      {detail.truncated && <div className="border-t px-4 py-2 text-xs text-muted-foreground">Diff truncated · showing the first part of {detail.bytes} bytes</div>}
    </>
  );
}
