// Per-tool plain-text renderers for the MCP tools whose whole result is text:
// the five recon read tools (list_projects, list_worktrees, list_sessions,
// describe_session, project_status) plus describe_playbook.
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
//                  worktrees[].sessions.{archivedCount,lastActivity} — per-worktree
//                  session detail, a 2-call derivation away via
//                  list_sessions({project, worktree}). Accepted: a leaner
//                  default listing is worth the second call.
//                  The live workers themselves — `live N` is a COUNT. Naming
//                  them is list_sessions' job, and printing both made the two
//                  tools look like they disagreed whenever a worker exited
//                  between the calls.
//   list_sessions  pid (no tool takes one — sessionId is the handle);
//                  createdAt (status + lastResponseAt answer "is it moving?");
//                  contextWindowTokens (a denominator with no numerator on this
//                  surface — the actionable overage signals are DEVIANT);
//                  on an INACTIVE row, every runtime field — there is no
//                  process to read a status/effort/model off, so the row is a
//                  short session line rather than a worker block full of —,
//                  and `size`, which identifies nothing a resume needs.
//                  A recorded `mode` is NOT rendered as a field either; the one
//                  mode fact that matters off-process is "would resuming this
//                  come up hot", which is a DEVIANT flag (resumes-hot).
//   both           firstPrompt when a title exists — the title supersedes it.
//   describe_session
//                  on the RETIRED branch, the same runtime fields list_sessions
//                  drops from an inactive row, for the same reason — there is no
//                  process to read a mode/effort/model off. The LIVE branch drops
//                  nothing list_sessions does not: it renders the identical block.
//                  Location is rendered on the RETIRED branch ONLY — see
//                  renderSession for why the asymmetry is deliberate.
//
// Handles stay full-length: sessionIds, absolute paths, branch names. A baseSha
// is informational context, not something pasted back into a call, so it is
// shortened (SHA_LEN).

import {
  DASH, block, dash, deviations, heading, indent, table, trunc, ts,
  type DeviantSpec,
} from './textRender.ts';
// The one definition of "resuming this lands ungated" — shared with the resume
// path itself so the flag and the behaviour cannot drift.
import { resumesHot } from '../sessionModes.ts';

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
  return `sessions ${dash(s.count ?? 0)}${archived}   last ${ts(s.lastActivity)}`;
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
  // The project's System could not be resolved, so every git fact below is
  // ABSENT rather than measured. It leads the block because it is the reason
  // the rest is missing — and it is why `isGitRepo` is reported `undefined`
  // (skipped) rather than `false` on such a row: "could not look" is not the
  // claim "not a git repo".
  { key: 'systemUnreachable', default: null, label: '! system unreachable' },
  { key: 'isGitRepo', default: true, label: '! not a git repo' },
  { key: 'unbornHead', default: false, label: '! no commits yet — a worktree needs a first commit' },
  // Adopted from outside the projects root. The real target path is already the
  // `▸ <name>  <path>` header, so this only has to say WHICH kind it is.
  { key: 'external', default: false, label: 'external' },
  // The System the tree lives on. DEVIANT for the same reason `external` is:
  // `local` is where every project is unless its record says otherwise, so the
  // common listing stays short and a project on another machine says so — with
  // the path on that machine, which the `▸` header does not carry.
  { key: 'system', default: 'local', label: 'system' },
  // WHICH TARGET of that system. Deviant on the same footing: absence is the
  // provider's own target, so only a project that names one says so.
  { key: 'remoteId', default: null, label: 'remoteId' },
  { key: 'systemPath', default: null, label: 'systemPath' },
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

// ---------- list_sessions ----------
//
// `cwd` is rendered on every LIVE row. It is the conductor's self-identification
// check — "the one whose cwd ends in .conduct" (conventions/conductor/core.md)
// — so it has to be readable straight off the text. Same for firstPrompt/title,
// which back "only drive workers you spawned". Neither may be dropped.

const INSTANCE_DEVIANT: DeviantSpec[] = [
  { key: 'temp', default: false, label: 'temp' },
  { key: 'conducted', default: false, label: 'conducted' },
  { key: 'debug', default: false, label: 'debug' },
  { key: 'overageActive', default: false, label: 'OVERAGE' },
  { key: 'overageResetsAt', default: null, label: 'overage-resets', fmt: ts },
  { key: 'autoResumeAt', default: null, label: 'auto-resume', fmt: ts },
  // Rotation tell. A never-rotated worker is the common case and carries no news,
  // so all three sit here rather than on a fixed line: `segmentCount` defaults to
  // 1 (one segment = never rotated), the other two to null.
  { key: 'lastRotatedAt', default: null, label: 'rotated', fmt: ts },
  { key: 'rotationReason', default: null, label: 'rotated-by' },
  { key: 'segmentCount', default: 1, label: 'segments' },
];

function instanceRows(rows: Row[]): Array<string | string[]> {
  const parts: Array<string | string[]> = [];
  rows.forEach((r, i) => {
    const lines: string[] = [
      `status ${dash(r.status)}   display ${dash(r.displayStatus)}   agents ${dash(r.activeAgentTasks ?? 0)}   queued ${dash(r.queuedCount ?? 0)}   awaiting-wake ${r.awaitingWake ? 'yes' : 'no'}`,
      `project ${dash(r.project)}   worktree ${worktreeName(r.worktree)}`,
      `cwd ${dash(r.cwd)}`,
      `mode ${dash(r.mode)}   effort ${dash(r.effort)}   thinking ${dash(r.thinking)}   model ${dash(r.backend)}/${dash(r.model)}`,
      `playbook ${dash(r.playbook)} / ${dash(r.stage)}`,
      `title ${r.title == null ? `${DASH}   first ${trunc(r.firstPrompt, 100)}` : trunc(r.title, 100)}`,
      `last ${ts(r.lastResponseAt)}`,
    ];
    const dev = deviations(r, INSTANCE_DEVIANT);
    if (dev.length) lines.push(`flags ${dev.join('  ')}`);
    parts.push(`[${i + 1}] LIVE ${dash(r.sessionId)}`);
    parts.push(indent(lines, 4));
    parts.push('');
  });
  return parts;
}

// Inactive rows are SessionRows (src/projects.ts) — persisted sessions with no
// live process. They carry none of a worker's runtime facts (no status, effort
// or model) because there is no process to have them, so they render as ONE
// compact line each rather than a 7-line worker block padded with — , which
// would imply those fields were looked up and came back empty. A reader cannot
// confuse the two shapes: a live worker is an indented multi-line block, an
// inactive session is a single table row.
//
// The columns are what identifies a session for a RESUME — id, when, what
// workflow it is mid-way through, what it would come back as, what it was
// about. `size` is gone: it identifies nothing and cost a column.
const SESSION_DEVIANT: DeviantSpec[] = [
  { key: 'conducted', default: false, label: 'conducted' },
  { key: 'temp', default: false, label: 'temp' },
  { key: 'archived', default: false, label: 'archived' },
  // Safety flag, not a mode column. It reads off SessionRow.resumeMode, which
  // is the EFFECTIVE mode (recorded, else DEFAULT_RESUME_MODE) — so a session
  // with no record still flags, because resuming it still comes up hot. The
  // flag must never be absent on a resume that lands ungated.
  { key: 'resumesHot', default: false, label: 'resumes-hot' },
];

function inactiveRows(rows: Row[]): string[] {
  const flagged: Row[] = rows.map(r => ({ ...r, resumesHot: resumesHot(String(r.resumeMode ?? '')) }));
  return table(flagged.map(s => [
    String(dash(s.sessionId)),
    ts(s.lastActivity),
    s.playbook ? `${dash(s.playbook)}/${dash(s.stage)}` : DASH,
    deviations(s, SESSION_DEVIANT).join(',') || DASH,
    trunc(s.title ?? s.firstPrompt, 60),
  ]), ['l', 'l', 'l', 'l', 'l']);
}

// One directory's sessions: the main checkout or a single worktree.
interface SessionGroup {
  project: string;
  worktree: string | null;
  path: string;
  branch: string | null;
  mergeStatus: { ahead: number | null; behind: number | null } | null;
  live: Row[];
  inactive: Row[];
  archivedCount: number;
}

const asGroups = (v: unknown): SessionGroup[] => (Array.isArray(v) ? v as SessionGroup[] : []);

const counts = (live: number, inactive: number, archived: number) =>
  `live ${live} · inactive ${inactive} · archived ${archived}`;

// A group header's divergence, LABELLED with what it is measured against.
// Only a worktree has one: it is commits vs the base branch it will merge back
// into, which is what decides whether resuming into it is useful. A main
// checkout's equivalent would be vs its remote upstream — a different question
// — so it renders nothing here rather than an unlabelled number the reader
// would take for the same measurement. `vs base` is what makes that silence
// read as "different question" instead of "not computed"; list_projects still
// reports upstream status for a project.
function groupDivergence(v: unknown): string {
  const m = asRow(v);
  const n = (x: unknown) => (typeof x === 'number' ? String(x) : '?');
  return `↑${n(m.ahead)} ↓${n(m.behind)} vs base`;
}

// Groups arrive already ordered and filtered — the caller (src/mcp/handlers.ts
// listSessions) owns the isDeadStatus() split, the session scan, the git
// lookups and every sort, so this stays a pure formatter with no instance-model
// or filesystem dependency.
//
// Ordering is load-bearing: the main checkout comes first in every project,
// because it is the one group that always exists, so the top of the output
// stays put as worktrees come and go. Live rows lead their group.
//
// `project` is echoed on the heading whenever the caller filtered, because an
// empty filtered list otherwise reads as "no sessions anywhere" and would send
// a conductor down the wrong path.
//
// `expanded` says the caller passed includeArchived, i.e. the archived rows are
// already in `inactive`. It gates the `+N archived` CALL TO ACTION only, never
// the count: `archivedCount` is deliberately counted before the filter, so the
// group header's `archived N` is right in both forms. Without this the expanded
// listing prints every archived row and then invites the reader to pass a flag
// they already passed, to reveal sessions that are already on screen.
export function renderSessions(
  groups: unknown,
  { project = null, expanded = false }: { project?: string | null; expanded?: boolean } = {},
): string {
  const all = asGroups(groups);
  const sum = (pick: (g: SessionGroup) => number, rows: SessionGroup[] = all) =>
    rows.reduce((n, g) => n + pick(g), 0);
  const filter = project ? `  project ${project}` : '';
  const parts: Array<string | string[]> = [
    `SESSIONS (${counts(sum(g => g.live.length), sum(g => g.inactive.length), sum(g => g.archivedCount))})${filter}`,
    '',
  ];
  if (!all.length) return block(...parts).trimEnd();

  // Group headers repeat per project so an unfiltered call stays readable.
  const projects: string[] = [];
  for (const g of all) if (!projects.includes(g.project)) projects.push(g.project);

  for (const name of projects) {
    const mine = all.filter(g => g.project === name);
    const root = mine.find(g => g.worktree === null);
    parts.push(`▸ ${name}  ${dash(root?.path)}   ${counts(
      sum(g => g.live.length, mine), sum(g => g.inactive.length, mine), sum(g => g.archivedCount, mine))}`);
    for (const g of mine) {
      const head = g.worktree === null ? 'main checkout' : `worktree ${g.worktree}`;
      const ab = g.mergeStatus ? `   ${groupDivergence(g.mergeStatus)}` : '';
      const body: Array<string | string[]> = [
        `${head}  br ${dash(g.branch)}${ab}   ${counts(g.live.length, g.inactive.length, g.archivedCount)}`,
      ];
      // The worktree's own path — the main checkout's is on the project header.
      if (g.worktree !== null) body.push(indent([dash(g.path)], 2));
      const inner: Array<string | string[]> = [...instanceRows(g.live)];
      if (g.inactive.length) inner.push(inactiveRows(g.inactive));
      if (g.archivedCount && !expanded) inner.push(`+${g.archivedCount} archived (includeArchived:true to list)`);
      body.push(indent(block(...inner).split('\n'), 2));
      parts.push(indent(block(...body).split('\n'), 2));
      parts.push('');
    }
  }
  return block(...parts).trimEnd();
}

// ---------- describe_session ----------

// One session, live or retired. Both branches REUSE list_sessions' own row
// renderers verbatim (instanceRows / inactiveRows), so the two tools cannot
// drift on what a row says — which is the whole value of the tool: the same row
// list_sessions prints, addressable by handle.
//
// The location block is on the RETIRED branch only, deliberately: instanceRows
// already renders project / worktree / cwd, so hoisting them into the header
// would print them twice, while inactiveRows carries no location at all (in
// list_sessions that is the group header's job, and describe_session has no
// group). Same shape as renderWorktrees below, which hoists the row-invariant
// parentProject into its header and drops it from the rows.
export function renderSession(session: unknown): string {
  const s = asRow(session);
  const live = s.live ? asRow(s.live) : null;
  const head = `SESSION ${dash(s.sessionId)}   ${live ? 'live' : 'retired'}`;
  if (live) return block(head, '', ...instanceRows([live]));
  return block(
    head,
    indent([
      `project ${dash(s.project)}   worktree ${worktreeName(s.worktree)}`,
      `path ${dash(s.path)}`,
    ], 4),
    '',
    s.retired ? inactiveRows([asRow(s.retired)]) : null,
  );
}

// ---------- list_worktrees ----------

export function renderWorktrees(worktrees: unknown): string {
  const rows = asRows(worktrees);
  const head = heading('WORKTREES', rows.length);
  if (!rows.length) return head;
  // parentProject is identical across every row (the tool takes one project, and
  // a worktree records the ROOT project even when it is based on another
  // worktree), so it renders once as a header. parentPath is NOT row-invariant —
  // a worktree based on another records that one's checkout — and is derivable
  // anyway: for a root-based worktree it is the project path list_projects
  // prints, and for a derived one it is the base worktree's own worktreePath
  // line below. So it is not rendered rather than rendered per row.
  const parts: Array<string | string[]> = [
    `${head} — ${dash(rows[0].parentProject)}`, '',
  ];
  const cells = rows.map(w => [
    String(dash(w.worktree)),
    `br ${dash(w.branch)}`,
    `base ${dash(w.baseBranch)}@${shortSha(w.baseSha)}` +
      (typeof w.baseWorktree === 'string' && w.baseWorktree ? ` ← ${w.baseWorktree}` : ''),
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
  } else if (s.unbornHead) {
    // No `base …` line: that line is worktree-only, and a worktree is created
    // off a sha, so it can never be unborn.
    parts.push(`branch ${dash(s.branch)}`);
    parts.push('HEAD — no commits yet');
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
  // An unanswered status prints as UNKNOWN rather than as an empty DIRTY
  // heading, which reads as the positive claim that the tree is clean.
  if (s.dirtyUnknown) {
    parts.push('DIRTY (unknown — git status did not answer)');
  } else {
  parts.push('');
  parts.push(s.dirtyTruncated
    ? `DIRTY (${dirty.length} of ${dash(s.dirtyTotal)} — truncated)`
    : heading('DIRTY', dirty.length));
  parts.push(indent(dirty.map(String), 2));
  }

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

// ---------- describe_playbook ----------
//
// The sibling renderer is renderPlaybookConvention (src/playbookConvention.ts),
// which renders a playbook into the conductor's SYSTEM PROMPT and deliberately
// omits `tools`, `needs` and `spawnable` (docs/protocol.md → Playbooks). Do not
// merge the two: this surface answers "what does this stage permit?" when asked,
// and folding it into the prompt renderer would push every stage's tools policy
// into every conductor's system prompt.
//
// Assembled by hand instead of with block(): block() collapses blank-line runs
// and strips trailing whitespace, but an authored `description` — any non-empty
// string readDescription accepts, blank-line runs included — must reach the
// reader VERBATIM, never reflowed, truncated or summarised.

// Authored prose goes under its own label, one level deeper than the fields
// above it. The label is what tells a reader where the rendering stops and the
// author's text begins; the extra indent keeps prose out of the columns the
// renderer itself emits at (0 for a stage header, 4 for its fields).
//
// What that does NOT buy: a prose line indented to match a rendered field —
// "      set_mode deny" inside a description — is byte-identical to a real tools
// entry, and no label or indent separates those. Nothing here can fix that, and
// nothing tries to: the containment is editorial, the rule being that a
// description states the conductor's MOVE and never restates the graph
// (docs/protocol.md → Playbooks, "Optional `description`").
//
// Absent (unauthored) means NO line at all, not a — : the field is either
// authored prose or nothing.
function describedBlock(label: string, description: unknown, at: number): string[] {
  if (typeof description !== 'string') return [];
  return [...indent([label], at), ...indent(description.split('\n'), at + 2)];
}

// Three-way rather than truthiness, so a payload that stopped carrying the
// derived field reads as absent instead of quietly reporting "no".
function yesNo(v: unknown): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return DASH;
}

// One JSON.stringify of the whole `pin` map: lossless by construction, and
// it keeps "plan" distinct from plan, true from "true", and null from absent —
// distinctions a caller acts on, since these are the argument values the gate
// enforces (ARG_PIN_CONFLICT).
function toolPolicy(policy: unknown): string {
  if (policy && typeof policy === 'object' && 'pin' in (policy as Row)) {
    return `pin ${JSON.stringify((policy as Row).pin)}`;
  }
  return dash(policy);
}

// `workers` and `spawnable` are rendered unconditionally, NOT through
// deviations(): "what does this stage permit?" needs both answers stated. That
// deliberately differs from renderPlaybookConvention's stageFlags, which
// suppresses the `workers: "one"` default — different surface, different rule.
// One cell per need, carrying both axes: `<anchor>@<liveness> in <positions>`.
// The anchor is doing double duty — the stage the worker must have passed
// through AND the key its sessionId is passed under — so it leads. Position is
// rendered even when it is the default [anchor]: a reader checking a list
// against the graph needs to see the list, and "absent means the anchor alone"
// is a rule they would have to already know.
function needCell(n: Row): string {
  const position = Array.isArray(n.position) ? n.position.map(String) : [];
  const where = position.length ? position.join('|') : DASH;
  return `${dash(n.stage)}@${dash(n.liveness)} in ${where}`;
}

function stageBlock(name: string, stage: Row): string[] {
  const needs = asRows(stage.needs).map(needCell);
  // Definition order, never sorted — the author's reading order IS the graph's.
  const tools = Object.entries(asRow(stage.tools));
  return [
    `▸ ${name}   workers ${dash(stage.workers)}   spawnable ${yesNo(stage.spawnable)}`,
    ...indent([`needs ${needs.length ? needs.join(', ') : DASH}`], 4),
    // A line per tool rather than one packed line: these entries carry nested
    // values, and the "*" fallback has to be readable as an entry of its own.
    ...indent([heading('tools', tools.length)], 4),
    ...indent(tools.map(([tool, policy]) => `${tool} ${toolPolicy(policy)}`), 6),
    ...describedBlock('description', stage.description, 4),
  ];
}

// `id` and `name` sit on separate lines because every built-in `name` already
// contains an em dash, so a "<id> — <name>" header would read as three fields.
export function renderPlaybook(playbook: unknown): string {
  const pb = asRow(playbook);
  const entry = Array.isArray(pb.entryStages) ? pb.entryStages.map(String) : [];
  const stages = Object.entries(asRow(pb.stages));
  const edges = asRows(pb.transitions);

  const lines: string[] = [
    `PLAYBOOK ${dash(pb.id)}`,
    `name ${dash(pb.name)}`,
    // dash(), not a bare join: entryStages is legitimately empty when no stage
    // declares spawn_instance, and a blank `entry` line would read as a bug.
    `entry ${entry.length ? entry.join(', ') : DASH}`,
  ];
  const description = describedBlock('DESCRIPTION', pb.description, 0);
  if (description.length) lines.push('', ...description);

  lines.push('', heading('STAGES', stages.length));
  for (const [name, stage] of stages) lines.push(...stageBlock(name, asRow(stage)));

  lines.push('', heading('TRANSITIONS', edges.length));
  const cells = table(edges.map(t => [`${dash(t.from)} → ${dash(t.to)}`, `via ${dash(t.via)}`]));
  cells.forEach((line, i) => {
    lines.push(`  ${line}`);
    lines.push(...describedBlock('description', edges[i].description, 4));
  });
  return lines.join('\n');
}
