// Pairs a hunk's lines into side-by-side rows for the split diff view.

export type DiffLineType = 'add' | 'del' | 'ctx';
/** One hunk as the diff endpoints send it (`src/gitDiff.ts` DiffHunk). */
export type DiffHunk = { header: string; lines: readonly { type: string; content: string }[] };
/** One side of a split row; `num` is that side's file line number, null when the header gives no start. */
export type SplitCell = { type: DiffLineType; num: number | null; content: string };
/** left = the old file, right = the new file; null = a blank filler cell. */
export type SplitRow = { left: SplitCell | null; right: SplitCell | null };

export function lineType(t: string): DiffLineType {
  return t === 'add' || t === 'del' ? t : 'ctx';
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The first old and new line numbers of a git hunk header; counts are ignored (a truncated diff's last hunk is short). */
export function hunkStarts(header: string): { old: number; new: number } | null {
  const m = HEADER.exec(header);
  return m ? { old: Number(m[1]), new: Number(m[2]) } : null;
}

/** Pairs a hunk into side-by-side rows: context on both sides, each run of changes as its deletions beside its additions. */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const starts = hunkStarts(hunk.header);
  let oldN = starts ? starts.old : null;
  let newN = starts ? starts.new : null;
  const rows: SplitRow[] = [];
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const ln of hunk.lines) {
    const type = lineType(ln.type);
    if (type === 'del') {
      dels.push({ type, num: oldN, content: ln.content });
      if (oldN !== null) oldN++;
    } else if (type === 'add') {
      adds.push({ type, num: newN, content: ln.content });
      if (newN !== null) newN++;
    } else {
      flush();
      rows.push({ left: { type, num: oldN, content: ln.content }, right: { type, num: newN, content: ln.content } });
      if (oldN !== null) oldN++;
      if (newN !== null) newN++;
    }
  }
  flush();
  return rows;
}
