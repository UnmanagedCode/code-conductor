// Per-tool plain-text renderers for the five MCP recon read tools:
// list_projects, list_instances, list_worktrees, list_sessions, project_status.
//
// Each tool's result is a text rendering (content[0]) plus the unchanged object
// as structuredContent — see src/mcp/content.ts renderedResult(). These
// functions produce the text half; they are pure, so tests pin exact strings.
//
// FIELD CLASSIFICATION. Every payload key belongs to exactly one of three
// per-tool constants, and tests/mcp-text-render.test.mjs asserts the three cover
// the key set with no overlap and no gap. That assertion is the "no field drops"
// guarantee — a key added upstream fails the suite until it is classified.
//
//   *_HOT      rendered in the text. Usually unconditionally; a few are rendered
//              by a rule the renderer owns (firstPrompt shows only when there is
//              no title to show instead) — the point is the reader can see it.
//   *_DEVIANT  rendered only when the value differs from the declared default.
//              For state a conductor must not miss (overage, archived, non-repo).
//              See src/mcp/textRender.ts deviations().
//   *_COLD     structuredContent only. Only for a fact that is redundant on
//              screen or that a conductor does not act on.
//
// Handles — sessionId, absolute paths, branch names, shas — are never truncated
// anywhere in these renderings; they exist to be copied back into a call.

import {
  DASH, block, bytes, dash, deviations, heading, indent, table, trunc, ts,
  type DeviantSpec,
} from './textRender.ts';

type Row = Record<string, unknown>;

const asRows = (v: unknown): Row[] => (Array.isArray(v) ? v as Row[] : []);
const asRow = (v: unknown): Row => (v && typeof v === 'object' ? v as Row : {});

// ---------- shared fragments ----------

// summarizeSessions() shape, reused by list_projects at both project and
// worktree level.
const SESSION_SUMMARY_HOT = ['count', 'lastMtime'] as const;
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
// worktree tool takes; the rest of the object stays in structuredContent.
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

export const PROJECT_HOT = ['name', 'path', 'sessionIds', 'sessions', 'worktrees'] as const;
export const PROJECT_DEVIANT: DeviantSpec[] = [
  { key: 'workspace', default: null, label: 'workspace' },
  { key: 'isGitRepo', default: true, label: '! not a git repo' },
];
export const PROJECT_COLD: string[] = [];

// A worktree nested under its project. parentProject/parentPath are cold here
// and ONLY here: both are byte-identical to the enclosing project's name/path,
// printed one line above. list_worktrees, which has no such enclosing header,
// renders them (WORKTREE_HOT).
export const PROJECT_WORKTREE_HOT = [
  'worktreeName', 'worktreePath', 'branch', 'baseBranch', 'baseSha', 'createdAt',
  'mergeStatus', 'sessions',
] as const;
export const PROJECT_WORKTREE_DEVIANT: DeviantSpec[] = [];
export const PROJECT_WORKTREE_COLD = ['parentProject', 'parentPath'] as const;

export function renderProjects(projects: unknown): string {
  const rows = asRows(projects);
  const parts: Array<string | string[]> = [heading('PROJECTS', rows.length), ''];
  for (const p of rows) {
    const wts = asRows(p.worktrees);
    const ids = Array.isArray(p.sessionIds) ? p.sessionIds as unknown[] : [];
    const body: Array<string | string[]> = [];
    for (const d of deviations(p, PROJECT_DEVIANT)) body.push(d);
    body.push(sessionSummary(p.sessions));
    body.push(`live ${ids.length}`);
    body.push(indent(ids.map(String), 2));
    body.push(`worktrees ${wts.length}`);
    if (wts.length) {
      const cells = wts.map(w => [
        String(dash(w.worktreeName)),
        `br ${dash(w.branch)}`,
        `base ${dash(w.baseBranch)}@${dash(w.baseSha)}`,
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
// `cwd` is HOT. It is the conductor's self-identification check — "the one whose
// cwd ends in .conduct" (conventions/conductor/core.md) — so it has to be
// readable straight off the text, not only via structuredContent.

export const INSTANCE_HOT = [
  'sessionId', 'project', 'cwd', 'worktree', 'status', 'displayStatus',
  'activeAgentTasks', 'mode', 'effort', 'thinking', 'backend', 'model',
  'queuedCount', 'hasIdleSubscriber', 'playbook', 'stage', 'title',
  'firstPrompt', 'lastResponseAt',
] as const;
export const INSTANCE_DEVIANT: DeviantSpec[] = [
  { key: 'temp', default: false, label: 'temp' },
  { key: 'conducted', default: false, label: 'conducted' },
  { key: 'debug', default: false, label: 'debug' },
  { key: 'overageActive', default: false, label: 'OVERAGE' },
  { key: 'overageResetsAt', default: null, label: 'overage-resets', fmt: ts },
  { key: 'autoResumeAt', default: null, label: 'auto-resume', fmt: ts },
];
export const INSTANCE_COLD = ['pid', 'createdAt', 'contextWindowTokens'] as const;

export function renderInstances(instances: unknown): string {
  const rows = asRows(instances);
  const parts: Array<string | string[]> = [heading('INSTANCES', rows.length), ''];
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
  return block(...parts);
}

// ---------- list_worktrees ----------

export const WORKTREE_HOT = [
  'worktree', 'worktreePath', 'branch', 'baseBranch', 'baseSha', 'createdAt',
  'parentProject', 'parentPath',
] as const;
export const WORKTREE_DEVIANT: DeviantSpec[] = [];
export const WORKTREE_COLD: string[] = [];

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
    `base ${dash(w.baseBranch)}@${dash(w.baseSha)}`,
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

export const SESSION_HOT = ['sessionId', 'mtime', 'size', 'title', 'firstPrompt'] as const;
export const SESSION_DEVIANT: DeviantSpec[] = [
  { key: 'conducted', default: false, label: 'conducted' },
  { key: 'temp', default: false, label: 'temp' },
  { key: 'archived', default: false, label: 'archived' },
];
export const SESSION_COLD: string[] = [];

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

export const STATUS_HOT = [
  'project', 'worktree', 'cwd', 'files', 'branch', 'head', 'dirty', 'dirtyTotal',
  'recentCommits', 'baseBranch', 'baseSha', 'mergeStatus', 'diffStat',
] as const;
export const STATUS_DEVIANT: DeviantSpec[] = [
  { key: 'isGitRepo', default: true, label: '! not a git repo' },
  { key: 'dirtyTruncated', default: false, label: 'truncated' },
];
export const STATUS_COLD: string[] = [];

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
      parts.push(`base ${dash(s.baseBranch)}@${dash(s.baseSha)}   ${aheadBehind(s.mergeStatus)}`);
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
