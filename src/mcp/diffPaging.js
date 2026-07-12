// Diff-pagination engine for project_diff. Pure functions (only the
// `Buffer` global) lifted out of the handler shell in ./handlers.js: numstat /
// name-status parsing, a one-pass line index, and a byte-bounded line pager.
// The byte-cap / pagination / summary output shapes are a documented MCP
// contract — keep them identical.

// Parse `git diff --numstat` output into per-file {additions, deletions,
// binary}. Binary files render as "-\t-\t<path>". File order matches
// --name-status given identical flags, so callers zip the two by index.
export function parseNumstat(out) {
  const rows = [];
  for (const line of (out ?? '').split('\n')) {
    if (!line) continue;
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const addsField = line.slice(0, tab1);
    const delsField = line.slice(tab1 + 1, tab2);
    const binary = addsField === '-';
    rows.push({
      additions: binary ? 0 : (Number(addsField) || 0),
      deletions: binary ? 0 : (Number(delsField) || 0),
      binary,
    });
  }
  return rows;
}

// Parse `git diff --name-status` output into per-file {status, path,
// oldPath?}. Rename/copy rows (R###/C###) carry the old path first.
export function parseNameStatus(out) {
  const rows = [];
  for (const line of (out ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    const status = (code[0] || 'M').toUpperCase();
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      rows.push({ status, oldPath: parts[1], path: parts[2] });
    } else {
      rows.push({ status, path: parts[parts.length - 1] });
    }
  }
  return rows;
}

// Walk a unified-diff line array once, recording for each line the file it
// belongs to: {path, preambleLines, hunkAt} where preambleLines are the
// lines from "diff --git" up to (not including) the first "@@", and
// hunkAt[i] is the index of the active "@@" header for line i (or -1).
export function indexDiffLines(lines) {
  const fileOf = new Array(lines.length).fill(-1);   // index into files[]
  const hunkAt = new Array(lines.length).fill(-1);   // index of active @@ line
  const files = [];                                  // {path, start, preEnd}
  let cur = null;
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

// Line-based pager. Returns a page of whole lines starting at `offset`,
// filling until the next line would exceed `cap` bytes. Mid-file pages are
// prefixed with the file's preamble + active hunk header so they parse
// standalone. Snaps the cutoff back to a hunk boundary when cheap.
export function paginateDiff(lines, offset, cap, idx) {
  const { fileOf, hunkAt, files } = idx;
  const total = lines.length;
  if (offset >= total) {
    return { diff: '', cutoff: total, prefixLines: [] };
  }
  // Re-emit headers when the page starts mid-file (not on the diff --git line).
  const prefixLines = [];
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
