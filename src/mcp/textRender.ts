// Plain-text presentation primitives for MCP read-tool renderings.
//
// Tool-agnostic on purpose: this module knows how to align a column and how to
// spell a missing value, and nothing about projects, workers or worktrees. The
// per-tool renderers compose these (src/mcp/readRenderers.ts).
//
// Everything here is pure and synchronous — a renderer is a function of its
// payload, which is what lets the tests pin exact output strings.

export const DASH = '—';

// null / undefined / '' all read as "no value" in these payloads (an absent
// branch, an unnamed workspace, a worker with no title), so they collapse to one
// glyph rather than three spellings the reader has to learn.
export function dash(v: unknown): string {
  if (v === null || v === undefined || v === '') return DASH;
  return String(v);
}

// Timestamps arrive as epoch-ms (session lastActivity, lastResponseAt) OR as ISO
// strings (worktree createdAt), so both are accepted and normalised to one
// UTC form. 0 is the "never" sentinel summarizeSessions returns.
export function ts(v: unknown): string {
  if (v === null || v === undefined || v === 0 || v === '') return DASH;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return dash(v);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

export function bytes(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DASH;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = v / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

// Display truncation. Never applied to a handle (sessionId, absolute path,
// branch, sha) — those stay full-length so they can be copied back into a call.
export function trunc(s: unknown, n: number): string {
  const str = dash(s).replace(/\s+/g, ' ').trim();
  return str.length <= n ? str : `${str.slice(0, Math.max(0, n - 1))}…`;
}

export function heading(noun: string, n: number): string {
  return `${noun} (${n === 0 ? 'none' : n})`;
}

// Pad every column to its widest cell so a reader scanning down a column lands
// on the same fact each row. The last column is never padded (no trailing
// whitespace). Ragged rows are tolerated — a short row just ends early.
export function table(rows: string[][], align: Array<'l' | 'r'> = []): string[] {
  const width: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => { width[i] = Math.max(width[i] ?? 0, cell.length); });
  }
  return rows.map(row => row
    .map((cell, i) => (i === row.length - 1
      ? cell
      : (align[i] === 'r' ? cell.padStart(width[i]) : cell.padEnd(width[i]))))
    .join('  ')
    .trimEnd());
}

export function indent(lines: string[], n: number): string[] {
  const pad = ' '.repeat(n);
  return lines.map(l => (l === '' ? '' : pad + l));
}

// Join sections, dropping empties and collapsing blank-line runs, so a renderer
// can emit conditional sections without threading separator logic through every
// branch.
export function block(...parts: Array<string | string[] | null | undefined>): string {
  const lines: string[] = [];
  for (const p of parts) {
    if (p === null || p === undefined) continue;
    for (const l of Array.isArray(p) ? p : p.split('\n')) lines.push(l);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

// ---------- the cold-when-non-default rule ----------
//
// The rendering is a tool's entire result, so a field left out of it is gone.
// That is fine for a field the reader can derive or never acts on, but NOT for
// one whose non-default value changes what a conductor should do next — a
// worker in overage, an archived session, a directory that is not a git repo.
//
// deviations() is the one mechanism for those: declare the field's default once,
// and it surfaces in the text exactly when it deviates. A data table rather than
// per-renderer `if`s, so the defaults are auditable in one place.

export interface DeviantSpec {
  key: string;
  // The value at which the field carries no news and stays out of the text.
  default: unknown;
  // Text to emit. Defaults to the key. For a boolean field this is the whole
  // output ("archived"); otherwise the value is appended ("auto-resume 13:00Z").
  label?: string;
  fmt?: (v: unknown) => string;
}

export function deviations(row: Record<string, unknown>, spec: DeviantSpec[]): string[] {
  const out: string[] = [];
  for (const s of spec) {
    const v = row[s.key];
    if (v === undefined || Object.is(v, s.default)) continue;
    const label = s.label ?? s.key;
    if (typeof v === 'boolean') out.push(label);
    else out.push(`${label} ${s.fmt ? s.fmt(v) : dash(v)}`);
  }
  return out;
}
