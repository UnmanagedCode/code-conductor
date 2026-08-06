// Per-tool plain-text renderers for the five MCP recon read tools:
// list_projects, list_instances, list_worktrees, list_sessions, project_status.
//
// The rendering is the tool's ENTIRE result — there is no JSON channel beside
// it (src/mcp/content.ts textResult). So the bar is: every fact a conductor acts
// on must be in the text. These functions are pure, so tests pin exact strings.
//
// Two ways a field reaches the text. Most are rendered unconditionally. The
// rest are DEVIANT: declared with a default in a `DeviantSpec[]` and surfaced
// only when the value leaves it — overage, archived, a non-repo, a truncated
// dirty list. See src/mcp/textRender.ts deviations(). That is what lets the
// common case stay short without a conductor ever missing live state.
//
// DELIBERATELY DROPPED — not rendered, and no longer reachable anywhere:
//   list_projects  worktrees[].parentProject / .parentPath — byte-identical to
//                  the project header one line above (list_worktrees, which has
//                  no such header, does render them).
//                  worktrees[].sessions.{archivedCount,lastMtime} — per-worktree
//                  session detail, a 2-call derivation away via
//                  list_sessions({project, worktree}). Accepted: a leaner
//                  default listing is worth the second call.
//                  The live workers themselves — `live N` is a COUNT. Naming
//                  them is list_instances' job, and printing both made the two
//                  tools look like they disagreed whenever a worker exited
//                  between the calls.
//   list_instances pid (no tool takes one — sessionId is the handle);
//                  createdAt (status + lastResponseAt answer "is it moving?");
//                  contextWindowTokens (a denominator with no numerator on this
//                  surface — the actionable overage signals are DEVIANT).
//   both           firstPrompt when a title exists — the title supersedes it.
//
// Handles stay full-length: sessionIds, absolute paths, branch names. A baseSha
// is informational context, not something pasted back into a call, so it is
// shortened (SHA_LEN).

import {
  DASH, block, bytes, dash, deviations, heading, indent, table, trunc, ts,
  type DeviantSpec,
} from './textRender.ts';

type Row = Record<string, unknown>;

const asRows = (v: unknown): Row[] => (Array.isArray(v) ? v as Row[] : []);
const asRow = (v: unknown): Row => (v && typeof v === 'object' ? v as Row : {});

// ---------- shared fragments ----------

// Enough of a base sha to identify a commit at a glance; `git log` in the same
// rendering already prints 7.
const SHA_LEN = 12;
// Truncate, but keep dash()'s empty-string sentinel: '' must read as — like
// every other absent value, not as a bare `base main@`.
const shortSha = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, SHA_LEN) : dash(v));

// summarizeSessions() shape, reused by list_projects at both project and
// worktree level.
const SESSION_SUMMARY_DEVIANT: DeviantSpec[] = [
  { key: 'archivedCount', default: 0, label: 'archived' },
];

function sessionSummary(v: unknown): string {
  const s = asRow(v);
  const dev = deviations(s, SESSION_SUMMARY_DEVIANT);
  const archived = dev.length ? ` (${dev.join(', ')})` : '';
  return `sessions ${dash(s.count ?? 0)}${archived}   last ${ts(s.lastMtime)}`;
}

// An instance's `worktree` is the whole WorktreeMeta object (plus a
// postWorktreeCreate report), not a name — see InstanceSummary in
// src/instances.ts. The text carries the name, which is the handle every
// worktree tool takes; the rest of the object is not rendered.
function worktreeName(v: unknown): string {
  if (v && typeof v === 'object') return dash((v as Row).worktreeName);
  return dash(v);
}

function aheadBehind(v: unknown): string {
  const m = asRow(v);
  const n = (x: unknown) => (typeof x === 'number' ? String(x) : '?');
  return `ahead ${n(m.ahead)}  behind ${n(m.behind)}`;
}

// ---------- list_projects ----------

const PROJECT_DEVIANT: DeviantSpec[] = [
  { key: 'workspace', default: null, label: 'workspace' },
  { key: 'isGitRepo', default: true, label: '! not a git repo' },
];

export function renderProjects(projects: unknown): string {
  const rows = asRows(projects);
  const parts: Array<string | string[]> = [heading('PROJECTS', rows.length), ''];
  for (const p of rows) {
    const wts = asRows(p.worktrees);
    const body: Array<string | string[]> = [];
    for (const d of deviations(p, PROJECT_DEVIANT)) body.push(d);
    body.push(sessionSummary(p.sessions));
    // dash(), not `?? 0`: a handler that stopped supplying the count must read
    // as absent, not as a project nobody is working on.
    body.push(`live ${dash(p.liveCount)}`);
    body.push(`worktrees ${wts.length}`);
    if (wts.length) {
      const cells = wts.map(w => [
        String(dash(w.worktreeName)),
        `br ${dash(w.branch)}`,
        `base ${dash(w.baseBranch)}@${shortSha(w.baseSha)}`,
        aheadBehind(w.mergeStatus),
        `sessions ${dash(asRow(w.sessions).count ?? 0)}`,
        `created ${ts(w.createdAt)}`,
      ]);
      const lines: string[] = [];
      table(cells).forEach((line, i) => {
        lines.push(line);
        lines.push(`  ${dash(wts[i].worktreePath)}`);
      });
      body.push(indent(lines, 2));
    }
    parts.push(`▸ ${dash(p.name)}  ${dash(p.path)}`);
    parts.push(indent(block(...body).split('\n'), 2));
    parts.push('');
  }
  return block(...parts);
}

// ---------- list_instances ----------
//
// `cwd` is rendered on every row. It is the conductor's self-identification
// check — "the one whose cwd ends in .conduct" (conventions/conductor/core.md)
// — so it has to be readable straight off the text.

const INSTANCE_DEVIANT: DeviantSpec[] = [
  { key: 'temp', default: false, label: 'temp' },
  { key: 'conducted', default: false, label: 'conducted' },
  { key: 'debug', default: false, label: 'debug' },
  { key: 'overageActive', default: false, label: 'OVERAGE' },
  { key: 'overageResetsAt', default: null, label: 'overage-resets', fmt: ts },
  { key: 'autoResumeAt', default: null, label: 'auto-resume', fmt: ts },
  // When it died. Only ever set on an EXITED row, so it is news by definition —
  // "gone 2 minutes ago" and "gone 28 minutes ago, about to age out of the
  // retention window" call for different next moves.
  { key: 'exitedAt', default: null, label: 'exited', fmt: ts },
];

function instanceRows(rows: Row[]): Array<string | string[]> {
  const parts: Array<string | string[]> = [];
  rows.forEach((r, i) => {
    const lines: string[] = [
      `status ${dash(r.status)}   display ${dash(r.displayStatus)}   agents ${dash(r.activeAgentTasks ?? 0)}   queued ${dash(r.queuedCount ?? 0)}   idle-sub ${r.hasIdleSubscriber ? 'yes' : 'no'}`,
      `project ${dash(r.project)}   worktree ${worktreeName(r.worktree)}`,
      `cwd ${dash(r.cwd)}`,
      `mode ${dash(r.mode)}   effort ${dash(r.effort)}   thinking ${dash(r.thinking)}   model ${dash(r.backend)}/${dash(r.model)}`,
      `playbook ${dash(r.playbook)} / ${dash(r.stage)}`,
      `title ${r.title == null ? `${DASH}   first ${trunc(r.firstPrompt, 100)}` : trunc(r.title, 100)}`,
      `last ${ts(r.lastResponseAt)}`,
    ];
    const dev = deviations(r, INSTANCE_DEVIANT);
    if (dev.length) lines.push(`flags ${dev.join('  ')}`);
    parts.push(`[${i + 1}] ${dash(r.sessionId)}`);
    parts.push(indent(lines, 4));
    parts.push('');
  });
  return parts;
}

// `live` and `exited` arrive already partitioned and ordered — the caller
// (src/mcp/handlers.ts listInstances) owns both the isDeadStatus() split and the
// sort, so this stays a pure formatter with no instance-model dependency.
//
// The EXITED heading is omitted entirely when nothing has exited, so the common
// case does not grow a section; and `project` is echoed on the INSTANCES heading
// whenever the caller filtered, because an empty filtered list otherwise reads
// as "no workers anywhere" and would send a conductor down the wrong path.
export function renderInstances(
  instances: unknown,
  { project = null, exited = [] }: { project?: string | null; exited?: unknown } = {},
): string {
  const rows = asRows(instances);
  const dead = asRows(exited);
  const filter = project ? `  project ${project}` : '';
  const parts: Array<string | string[]> = [
    `${heading('INSTANCES', rows.length)}${filter}`, '',
    ...instanceRows(rows),
  ];
  if (dead.length) parts.push(heading('EXITED', dead.length), '', ...instanceRows(dead));
  return block(...parts);
}

// ---------- list_worktrees ----------

export function renderWorktrees(worktrees: unknown): string {
  const rows = asRows(worktrees);
  const head = heading('WORKTREES', rows.length);
  if (!rows.length) return head;
  // parentProject/parentPath are identical across every row (the tool takes one
  // project), so they render once as a header instead of on each line.
  const parts: Array<string | string[]> = [
    `${head} — ${dash(rows[0].parentProject)}  ${dash(rows[0].parentPath)}`, '',
  ];
  const cells = rows.map(w => [
    String(dash(w.worktree)),
    `br ${dash(w.branch)}`,
    `base ${dash(w.baseBranch)}@${shortSha(w.baseSha)}`,
    `created ${ts(w.createdAt)}`,
  ]);
  const lines: string[] = [];
  table(cells).forEach((line, i) => {
    lines.push(line);
    lines.push(`  ${dash(rows[i].worktreePath)}`);
  });
  parts.push(lines);
  return block(...parts);
}

// ---------- list_sessions ----------

const SESSION_DEVIANT: DeviantSpec[] = [
  { key: 'conducted', default: false, label: 'conducted' },
  { key: 'temp', default: false, label: 'temp' },
  { key: 'archived', default: false, label: 'archived' },
];

export function renderSessions(sessions: unknown): string {
  const rows = asRows(sessions);
  const head = heading('SESSIONS', rows.length);
  if (!rows.length) return head;
  const cells = rows.map(s => [
    String(dash(s.sessionId)),
    ts(s.mtime),
    bytes(s.size),
    deviations(s, SESSION_DEVIANT).join(',') || DASH,
    trunc(s.title ?? s.firstPrompt, 60),
  ]);
  return block(head, '', table(cells, ['l', 'l', 'r', 'l', 'l']));
}

// ---------- project_status ----------

export function renderProjectStatus(status: unknown): string {
  const s = asRow(status);
  const files = asRows(s.files);
  const head = asRow(s.head);
  const parts: Array<string | string[]> = [
    `${dash(s.project)}${s.worktree ? `  worktree ${dash(s.worktree)}` : ''}`,
    `cwd ${dash(s.cwd)}`,
  ];
  if (s.isGitRepo === false) {
    parts.push('! not a git repo');
  } else {
    parts.push(`branch ${dash(s.branch)}`);
    parts.push(`HEAD ${dash(head.sha)} ${trunc(head.subject, 100)}`);
    if (s.baseBranch !== undefined) {
      parts.push(`base ${dash(s.baseBranch)}@${shortSha(s.baseSha)}   ${aheadBehind(s.mergeStatus)}`);
    }
  }
  parts.push('');
  parts.push(heading('FILES', files.length));
  if (files.length) {
    parts.push(indent([files.map(f => `${dash(f.name)}${f.kind === 'dir' ? '/' : ''}`).join('  ')], 2));
  }
  if (s.isGitRepo === false) return block(...parts);

  const dirty = Array.isArray(s.dirty) ? s.dirty as unknown[] : [];
  parts.push('');
  parts.push(s.dirtyTruncated
    ? `DIRTY (${dirty.length} of ${dash(s.dirtyTotal)} — truncated)`
    : heading('DIRTY', dirty.length));
  parts.push(indent(dirty.map(String), 2));

  if (typeof s.diffStat === 'string') {
    parts.push('');
    parts.push(`DIFFSTAT (vs ${dash(s.baseBranch)})`);
    parts.push(indent(s.diffStat ? s.diffStat.split('\n') : [DASH], 2));
  }
  if (s.recentCommits !== undefined) {
    const commits = Array.isArray(s.recentCommits) ? s.recentCommits as unknown[] : [];
    parts.push('');
    parts.push(heading('COMMITS', commits.length));
    parts.push(indent(commits.map(String), 2));
  }
  return block(...parts);
}
