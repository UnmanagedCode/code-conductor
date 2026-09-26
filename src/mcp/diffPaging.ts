// Diff-pagination engine for project_diff. Pure functions (only the
// `Buffer` global) lifted out of the handler shell in ./handlers.ts: a
// one-pass line index, a byte-bounded line pager and a side-list capper. The
// byte-cap / pagination / summary output shapes are a documented MCP contract
// — keep them identical.

import { utf8Prefix } from './content.ts';

// The longest prefix of `items` whose JSON encoding fits `maxChars`, with the
// full count — project_diff's side lists (`untracked`, `uncommitted.files`,
// `includedFiles`/`omittedFiles`) grow with the change set, so each is capped
// and flagged `<list>Truncated` + `<list>Total` (project_status' dirty-list
// pattern).
export function capPathList<T>(items: T[], maxChars: number): { kept: T[]; total: number; truncated: boolean } {
  let used = 2; // the brackets
  let n = 0;
  for (; n < items.length; n++) {
    const add = JSON.stringify(items[n]).length + (n > 0 ? 1 : 0);
    if (used + add > maxChars) break;
    used += add;
  }
  return { kept: n === items.length ? items : items.slice(0, n), total: items.length, truncated: n < items.length };
}

export interface DiffFileInfo {
  path: string | null;
  start: number;
  preEnd: number;
  sawHunk: boolean;
}

export interface DiffIndex {
  fileOf: number[];
  hunkAt: number[];
  files: DiffFileInfo[];
}

// Walk a unified-diff line array once, recording for each line the file it
// belongs to: {path, preambleLines, hunkAt} where preambleLines are the
// lines from "diff --git" up to (not including) the first "@@", and
// hunkAt[i] is the index of the active "@@" header for line i (or -1).
export function indexDiffLines(lines: string[]): DiffIndex {
  const fileOf = new Array<number>(lines.length).fill(-1);   // index into files[]
  const hunkAt = new Array<number>(lines.length).fill(-1);   // index of active @@ line
  const files: DiffFileInfo[] = [];                          // {path, start, preEnd}
  let cur: DiffFileInfo | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = { path: m ? m[2] : null, start: i, preEnd: i + 1, sawHunk: false };
      files.push(cur);
    }
    if (cur) {
      fileOf[i] = files.length - 1;
      if (line.startsWith('@@ ')) {
        cur.sawHunk = true;
        hunkAt[i] = i;
      } else if (!cur.sawHunk) {
        cur.preEnd = i + 1; // still in the file preamble
      } else {
        // body line — inherits the most recent @@ within this file
        let h = -1;
        for (let j = i - 1; j >= cur.start; j--) {
          if (lines[j].startsWith('@@ ')) { h = j; break; }
        }
        hunkAt[i] = h;
      }
    }
  }
  return { fileOf, hunkAt, files };
}

export interface DiffPage {
  diff: string;
  cutoff: number;
  prefixLines: string[];
  // The page's one line was longer than the whole page and was cut to fit.
  lineTruncated?: true;
}

// Line-based pager. Returns a page of whole lines starting at `offset`,
// filling until the next line would exceed `cap` bytes. Mid-file pages are
// prefixed with the file's preamble + active hunk header so they parse
// standalone. Snaps the cutoff back to a hunk boundary when cheap. A single
// line longer than the room the page has is cut to fit, with an in-band
// marker, and the page reports lineTruncated — the only case a page carries
// less than whole lines, and the line still counts as served so paging
// progresses.
export function paginateDiff(lines: string[], offset: number, cap: number, idx: DiffIndex): DiffPage {
  const { fileOf, hunkAt, files } = idx;
  const total = lines.length;
  if (offset >= total) {
    return { diff: '', cutoff: total, prefixLines: [] };
  }
  // Re-emit headers when the page starts mid-file (not on the diff --git line).
  const prefixLines: string[] = [];
  const fi = fileOf[offset];
  if (offset > 0 && fi >= 0) {
    const f = files[fi];
    const startsAtPreamble = offset === f.start;
    if (!startsAtPreamble) {
      for (let j = f.start; j < f.preEnd; j++) prefixLines.push(lines[j]);
      const h = hunkAt[offset];
      // Only re-add the @@ header if the offset line isn't itself that header.
      if (h >= 0 && h !== offset) prefixLines.push(lines[h]);
    }
  }
  let bytes = 0;
  for (const p of prefixLines) bytes += Buffer.byteLength(p, 'utf8') + 1;

  const firstBytes = Buffer.byteLength(lines[offset], 'utf8') + 1;
  if (bytes + firstBytes > cap) {
    const marker = ` … [line cut: ${firstBytes - 1} bytes]`;
    const cut = utf8Prefix(lines[offset], Math.max(0, cap - bytes - 1 - Buffer.byteLength(marker, 'utf8'))) + marker;
    const diff = prefixLines.concat(cut).join('\n');
    return { diff, cutoff: offset + 1, prefixLines, lineTruncated: true };
  }

  let cutoff = offset;
  while (cutoff < total) {
    const lineBytes = Buffer.byteLength(lines[cutoff], 'utf8') + 1;
    if (bytes + lineBytes > cap && cutoff > offset) break;
    bytes += lineBytes;
    cutoff++;
    if (bytes >= cap && cutoff > offset) break;
  }

  // Hunk-snap (nice-to-have): if a later line in the page opened a new hunk,
  // snap the cutoff back to it so the page ends on a hunk boundary — but
  // only when it keeps most of the budget and still makes progress.
  if (cutoff < total && cutoff - offset > 1) {
    const window = Math.max(1, Math.floor((cutoff - offset) * 0.1));
    for (let j = cutoff - 1; j >= cutoff - window && j > offset; j--) {
      if (lines[j].startsWith('@@ ') || lines[j].startsWith('diff --git ')) {
        cutoff = j;
        break;
      }
    }
  }

  const body = lines.slice(offset, cutoff);
  const diff = prefixLines.length ? prefixLines.concat(body).join('\n') : body.join('\n');
  return { diff, cutoff, prefixLines };
}
