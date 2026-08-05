// Owns the REST diff surface for all three git-history views (worktree
// review, single-commit diff, uncommitted working tree). Each surface has a
// summary endpoint (per-file numstat/name-status, no cap — safe for any
// change size) and a per-file endpoint (full hunks for one path, fetched
// lazily by public/review.js when a card is expanded).
//
// The MCP project_diff handler (src/mcp/handlers.ts) shares DIFF_BYTE_CAP,
// assertValidBaseRef, parseNumstat and parseNameStatus with this module —
// that sharing is import-path only; project_diff's own behavior is untouched.

import { runGit, getWorktree } from './worktrees.ts';
import { getProject } from './projects.ts';

// Maximum bytes of raw git diff output to keep for a single file's unified
// diff. Shared by both diff surfaces (REST here + the MCP project_diff
// handler) so they behave consistently.
export const DIFF_BYTE_CAP = 200 * 1024;

// Per-file changed-line ceiling. Checked from --numstat BEFORE reading the
// unified diff, so a pathological file can never reach runGit's 16 MB maxBuffer.
export const FILE_DIFF_LINE_GUARD = 20_000;

// Security-relevant allow-list for a user-supplied diff base ref. The single
// definition of this regex — both the REST and MCP diff surfaces validate
// through assertValidBaseRef so the option-injection guard can't drift apart.
// Rejects leading '-' (would be parsed as a git flag) and anything outside the
// conservative ref-name character set.
const BASE_REF_RE = /^[A-Za-z0-9._/-]+$/;

// Throw a 400 if `ref` isn't a safe base ref. Callers decide WHEN to validate
// (each surface has its own "a baseRef was supplied" trigger) — this owns only
// the check + the canonical error.
export function assertValidBaseRef(ref: string): void {
  if (ref.startsWith('-') || !BASE_REF_RE.test(ref)) {
    throw Object.assign(new Error('invalid baseRef'), { statusCode: 400 });
  }
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: string;
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

// Parse a raw unified diff string (from `git diff --unified=N base...HEAD`)
// into a per-file array of structured objects. Pure string-walking, no deps.
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!raw || !raw.trim()) return files;

  // Each file section starts with "diff --git ...". Split there.
  const rawSections = raw.split('\ndiff --git ');
  for (let si = 0; si < rawSections.length; si++) {
    const section = si === 0 ? rawSections[si] : 'diff --git ' + rawSections[si];
    if (!section.startsWith('diff --git ')) continue;
    const lines = section.split('\n');

    const headerMatch = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!headerMatch) continue;

    let status = 'modified';
    let filePath = headerMatch[2]; // b-side path (current name)
    let oldPath: string | null = null;
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let adds = 0;
    let dels = 0;
    let inHunks = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!inHunks) {
        if (line.startsWith('new file mode')) {
          status = 'added';
        } else if (line.startsWith('deleted file mode')) {
          status = 'deleted';
        } else if (line.startsWith('rename from ')) {
          oldPath = line.slice('rename from '.length);
        } else if (line.startsWith('rename to ')) {
          filePath = line.slice('rename to '.length);
          status = 'renamed';
        } else if (line.startsWith('@@ ')) {
          inHunks = true;
          currentHunk = { header: line, lines: [] };
          hunks.push(currentHunk);
        }
      } else {
        if (line.startsWith('@@ ')) {
          currentHunk = { header: line, lines: [] };
          hunks.push(currentHunk);
        } else if (line.startsWith('+') && currentHunk) {
          currentHunk.lines.push({ type: 'add', content: line.slice(1) });
          adds++;
        } else if (line.startsWith('-') && currentHunk) {
          currentHunk.lines.push({ type: 'del', content: line.slice(1) });
          dels++;
        } else if (line.startsWith(' ') && currentHunk) {
          currentHunk.lines.push({ type: 'ctx', content: line.slice(1) });
        }
        // "\ No newline at end of file" and other metadata lines are skipped.
      }
    }

    files.push({ path: filePath, oldPath, status, adds, dels, hunks });
  }
  return files;
}

export interface NumstatRow {
  additions: number;
  deletions: number;
  binary: boolean;
}

// Parse `git diff --numstat` output into per-file {additions, deletions,
// binary}. Binary files render as "-\t-\t<path>". File order matches
// --name-status given identical flags, so callers zip the two by index.
export function parseNumstat(out: string | undefined): NumstatRow[] {
  const rows: NumstatRow[] = [];
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

export interface NameStatusRow {
  status: string;
  path: string;
  oldPath?: string;
}

// Parse `git diff --name-status` output into per-file {status, path,
// oldPath?}. Rename/copy rows (R###/C###) carry the old path first.
export function parseNameStatus(out: string | undefined): NameStatusRow[] {
  const rows: NameStatusRow[] = [];
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

// git --name-status codes -> the status words the client CSS/icon map expect
// (.review-status-added|deleted|modified|renamed, STATUS_ICON in public/review.js).
const NAME_STATUS_STATUS: Record<string, string> = {
  A: 'added', D: 'deleted', R: 'renamed', C: 'copied', M: 'modified', T: 'modified',
};

function mapStatus(code: string): string {
  return NAME_STATUS_STATUS[code] ?? 'modified';
}

// Throw an Error carrying an HTTP statusCode for the REST layer, using the
// same Object.assign pattern the routes consume (`err.statusCode`).
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function clampContext(contextLines: number): number {
  return Math.max(0, Math.min(50, Number.isFinite(Number(contextLines)) ? Math.floor(Number(contextLines)) : 3));
}

// A resolved diff target: the repo dir plus a builder for the git argv.
interface DiffTarget {
  cwd: string;
  // `opts` land right after the subcommand so both `git diff` and `git show`
  // accept them; `pathspec` (if any) goes last after `--`. Prepend
  // '--literal-pathspecs' (which must be git's FIRST arg, before the
  // subcommand) whenever pathspec is non-empty, so pathspec magic like
  // ':(exclude)' in a query param is inert.
  argv: (opts: string[], pathspec: string[]) => string[];
}

export interface DiffFileSummary {
  path: string;
  oldPath: string | null;
  status: string;
  adds: number;
  dels: number;
  binary: boolean;
}

export interface DiffFileDetail extends DiffFileSummary {
  hunks: DiffHunk[];
  truncated: boolean;
  oversized: boolean;
  bytes: number;
}

// Runs two `runGit` calls in parallel with identical flags so the two outputs
// list files in the same order and zip by index — mirrors projectDiff()'s
// summary mode (src/mcp/handlers.ts).
async function summarizeTarget(t: DiffTarget): Promise<{ files: DiffFileSummary[]; totalAdds: number; totalDels: number }> {
  const [rn, rns] = await Promise.all([
    runGit(t.cwd, t.argv(['--numstat', '-M'], [])),
    runGit(t.cwd, t.argv(['--name-status', '-M'], [])),
  ]);
  if (rn.code !== 0) throw httpError(500, (rn.stderr || rn.stdout).trim() || 'git numstat failed');
  if (rns.code !== 0) throw httpError(500, (rns.stderr || rns.stdout).trim() || 'git name-status failed');

  const nums = parseNumstat(rn.stdout);
  const stats = parseNameStatus(rns.stdout);
  const files: DiffFileSummary[] = stats.map((s, i) => {
    const n = nums[i] ?? { additions: 0, deletions: 0, binary: false };
    return {
      path: s.path,
      oldPath: s.oldPath ?? null,
      status: mapStatus(s.status),
      adds: n.additions,
      dels: n.deletions,
      binary: n.binary,
    };
  });
  const totalAdds = files.reduce((s, f) => s + f.adds, 0);
  const totalDels = files.reduce((s, f) => s + f.dels, 0);
  return { files, totalAdds, totalDels };
}

async function fileDiffForTarget(
  t: DiffTarget, filePath: string, oldPathHint: string | null, ctx: number,
): Promise<DiffFileDetail> {
  // Learn oldPath (if any) from a name-status pass scoped to just the new
  // path — the client only sends the new path.
  let oldPath = oldPathHint;
  if (oldPath === null) {
    const nsR = await runGit(t.cwd, t.argv(['--name-status', '-M'], [filePath]));
    if (nsR.code === 0) {
      const rows = parseNameStatus(nsR.stdout);
      if (rows[0]?.oldPath) oldPath = rows[0].oldPath;
    }
  }
  const pathspec = oldPath ? [oldPath, filePath] : [filePath];

  const numR = await runGit(t.cwd, t.argv(['--numstat', '-M'], pathspec));
  if (numR.code !== 0) throw httpError(500, (numR.stderr || numR.stdout).trim() || 'git numstat failed');
  const numRows = parseNumstat(numR.stdout);
  if (numRows.length === 0) {
    throw httpError(404, `path '${filePath}' is not part of this diff`);
  }
  const nsR = await runGit(t.cwd, t.argv(['--name-status', '-M'], pathspec));
  const nsRows = nsR.code === 0 ? parseNameStatus(nsR.stdout) : [];
  const status = mapStatus(nsRows[0]?.status ?? 'M');
  const adds = numRows.reduce((s, r) => s + r.additions, 0);
  const dels = numRows.reduce((s, r) => s + r.deletions, 0);
  const binary = numRows.some(r => r.binary);

  const summaryFields: DiffFileSummary = { path: filePath, oldPath, status, adds, dels, binary };

  if (binary) {
    return { ...summaryFields, hunks: [], truncated: false, oversized: false, bytes: 0 };
  }
  if (adds + dels > FILE_DIFF_LINE_GUARD) {
    return { ...summaryFields, hunks: [], truncated: false, oversized: true, bytes: 0 };
  }

  const diffR = await runGit(t.cwd, t.argv([`--unified=${ctx}`, '--no-color', '-M'], pathspec));
  if (diffR.code !== 0) {
    throw httpError(500, (diffR.stderr || diffR.stdout).trim() || 'git diff failed');
  }
  const rawOutput = diffR.stdout;
  const bytes = rawOutput.length;
  let raw = rawOutput;
  let truncated = false;
  if (rawOutput.length > DIFF_BYTE_CAP) {
    truncated = true;
    const lastNewline = rawOutput.lastIndexOf('\n', DIFF_BYTE_CAP);
    raw = rawOutput.slice(0, lastNewline >= 0 ? lastNewline : DIFF_BYTE_CAP);
  }
  const parsed = parseUnifiedDiff(raw);
  const hunks = parsed[0]?.hunks ?? [];
  return { ...summaryFields, hunks, truncated, oversized: false, bytes };
}

async function worktreeTarget(
  projectName: string, worktreeName: string, baseRef: string | undefined,
): Promise<{ target: DiffTarget; ref: string }> {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    throw httpError(404, `worktree '${worktreeName}' not found under project '${projectName}'`);
  }
  const ref = baseRef || meta.baseBranch;
  if (baseRef) assertValidBaseRef(ref);
  const target: DiffTarget = {
    cwd: meta.worktreePath,
    argv: (o, p) => [
      ...(p.length ? ['--literal-pathspecs'] : []),
      'diff', ...o, `${ref}...HEAD`,
      ...(p.length ? ['--', ...p] : []),
    ],
  };
  return { target, ref };
}

// Return structured summary diff data for a worktree relative to its base
// branch. Validates ownership via getWorktree (throws 404 if not found).
export async function getWorktreeDiff(
  projectName: string,
  worktreeName: string,
  { baseRef, contextLines = 3 }: { baseRef?: string; contextLines?: number } = {},
): Promise<{ project: string; worktreeName: string; baseRef: string; files: DiffFileSummary[]; totalAdds: number; totalDels: number; totalFiles: number }> {
  const { target, ref } = await worktreeTarget(projectName, worktreeName, baseRef);
  const { files, totalAdds, totalDels } = await summarizeTarget(target);
  return { project: projectName, worktreeName, baseRef: ref, files, totalAdds, totalDels, totalFiles: files.length };
}

// Return the full hunks for one file in a worktree diff, fetched lazily when
// its card is expanded in the review UI.
export async function getWorktreeFileDiff(
  projectName: string,
  worktreeName: string,
  filePath: string,
  { baseRef, contextLines = 3 }: { baseRef?: string; contextLines?: number } = {},
): Promise<{ project: string; path: string; file: DiffFileDetail }> {
  const { target } = await worktreeTarget(projectName, worktreeName, baseRef);
  const ctx = clampContext(contextLines);
  const file = await fileDiffForTarget(target, filePath, null, ctx);
  return { project: projectName, path: filePath, file };
}

// Fetch a commit's message + parent SHAs and decide whether it's a merge —
// shared by both the commit summary and per-file paths.
async function commitMeta(proj: { path: string }, sha: string): Promise<{ commitMessage: string | null; isMerge: boolean }> {
  const metaR = await runGit(proj.path, ['log', '-1', '--format=%B%x1f%P', sha]);
  if (metaR.code !== 0) {
    const stderr = (metaR.stderr || '').trim();
    const notFound = /unknown revision|bad revision|ambiguous argument/i.test(stderr);
    throw httpError(notFound ? 404 : 500, stderr || `git log ${sha} failed`);
  }
  const metaParts = metaR.stdout.split('\x1f');
  const commitMessage = metaParts.slice(0, -1).join('\x1f').trim() || null;
  const parents = (metaParts[metaParts.length - 1] || '').trim().split(/\s+/).filter(Boolean);
  return { commitMessage, isMerge: parents.length >= 2 };
}

function commitTarget(proj: { path: string }, sha: string, isMerge: boolean): DiffTarget {
  return {
    cwd: proj.path,
    argv: (o, p) => [
      ...(p.length ? ['--literal-pathspecs'] : []),
      'show', ...(isMerge ? ['--first-parent'] : []), '--format=', ...o, sha,
      ...(p.length ? ['--', ...p] : []),
    ],
  };
}

function assertValidSha(sha: string): void {
  if (!/^[0-9a-fA-F]{4,40}$/.test(String(sha))) {
    throw httpError(400, 'invalid commit sha');
  }
}

// Return structured summary diff data for the change introduced by a single
// commit. For merge commits, uses `--first-parent` so the diff shows the full
// aggregate the merged branch brought onto mainline instead of git's default
// combined diff (conflict hunks only, empty for a clean --no-ff merge).
export async function getCommitDiff(
  projectName: string,
  sha: string,
  { contextLines = 3 }: { contextLines?: number } = {},
): Promise<{ project: string; sha: string; commitMessage: string | null; files: DiffFileSummary[]; totalAdds: number; totalDels: number; totalFiles: number }> {
  const proj = await getProject(projectName);
  assertValidSha(sha);
  const { commitMessage, isMerge } = await commitMeta(proj, sha);
  const target = commitTarget(proj, sha, isMerge);
  const { files, totalAdds, totalDels } = await summarizeTarget(target);
  return { project: projectName, sha, commitMessage, files, totalAdds, totalDels, totalFiles: files.length };
}

// Return the full hunks for one file in a single commit's diff.
export async function getCommitFileDiff(
  projectName: string,
  sha: string,
  filePath: string,
  { contextLines = 3 }: { contextLines?: number } = {},
): Promise<{ project: string; path: string; file: DiffFileDetail }> {
  const proj = await getProject(projectName);
  assertValidSha(sha);
  const { isMerge } = await commitMeta(proj, sha);
  const target = commitTarget(proj, sha, isMerge);
  const ctx = clampContext(contextLines);
  const file = await fileDiffForTarget(target, filePath, null, ctx);
  return { project: projectName, path: filePath, file };
}

function uncommittedTarget(proj: { path: string }): DiffTarget {
  return {
    cwd: proj.path,
    argv: (o, p) => [
      ...(p.length ? ['--literal-pathspecs'] : []),
      'diff', ...o, 'HEAD',
      ...(p.length ? ['--', ...p] : []),
    ],
  };
}

// Return structured summary diff data for all uncommitted changes in a
// project's working tree (staged + unstaged vs HEAD). If HEAD doesn't exist
// (fresh repo with no commits), returns an empty file list rather than
// throwing — the frontend treats this as "no diff to show".
export async function getProjectUncommittedDiff(
  projectName: string,
  { contextLines = 3 }: { contextLines?: number } = {},
): Promise<{ project: string; files: DiffFileSummary[]; totalAdds: number; totalDels: number; totalFiles: number }> {
  const proj = await getProject(projectName);
  const target = uncommittedTarget(proj);
  const probe = await runGit(proj.path, ['rev-parse', '--verify', 'HEAD']);
  if (probe.code !== 0) {
    return { project: projectName, files: [], totalAdds: 0, totalDels: 0, totalFiles: 0 };
  }
  const { files, totalAdds, totalDels } = await summarizeTarget(target);
  return { project: projectName, files, totalAdds, totalDels, totalFiles: files.length };
}

// Return the full hunks for one file in the uncommitted working-tree diff.
export async function getProjectUncommittedFileDiff(
  projectName: string,
  filePath: string,
  { contextLines = 3 }: { contextLines?: number } = {},
): Promise<{ project: string; path: string; file: DiffFileDetail }> {
  const proj = await getProject(projectName);
  const target = uncommittedTarget(proj);
  const ctx = clampContext(contextLines);
  const file = await fileDiffForTarget(target, filePath, null, ctx);
  return { project: projectName, path: filePath, file };
}
