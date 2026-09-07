// Plain-text rendering layer for the MCP tools whose whole result is text: the
// five recon read tools plus describe_playbook.
//
// Pure tests — no server boot, no I/O: hand-built payloads in, exact strings
// out, mirroring tests/mcp-recent-turn-bond.test.mjs. The rendering is the
// tool's ENTIRE result, so pinning it exactly is the point: anything not
// asserted here is a fact the conductor cannot get at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bytes, dash, deviations, heading, indent, table, trunc, ts, block, DASH,
} from '../src/mcp/textRender.ts';
import {
  renderProjects, renderWorktrees, renderSessions, renderSession, renderProjectStatus,
  renderPlaybook,
} from '../src/mcp/readRenderers.ts';
import { CONDUCTOR_VIEW_KEYS, LIST_ONLY_KEYS } from '../src/mcp/handlers.ts';
import { STAGE_KEYS, TRANSITION_KEYS, PLAYBOOK_KEYS } from '../src/playbooks.ts';

const SID_A = '3f2a8c11-77b2-4c1e-9a2f-5d6e7f801234';
const SID_B = '9b41d0e2-1a55-42c7-8f30-cc11ab993d02';

// ── primitives ─────────────────────────────────────────────────────────────

describe('textRender primitives', () => {
  test('dash collapses every "no value" spelling to one glyph', () => {
    for (const v of [null, undefined, '']) assert.equal(dash(v), DASH);
    assert.equal(dash(0), '0', '0 is a value, not an absence');
    assert.equal(dash(false), 'false');
    assert.equal(dash('main'), 'main');
  });

  test('ts normalises epoch-ms and ISO to one UTC form; 0/null are "never"', () => {
    assert.equal(ts(1786001000000), '2026-08-06 07:23Z');
    assert.equal(ts('2026-08-06T09:12:00.000Z'), '2026-08-06 09:12Z');
    assert.equal(ts(0), DASH);
    assert.equal(ts(null), DASH);
    assert.equal(ts('not a date'), 'not a date', 'unparseable input passes through');
  });

  test('bytes scales, sub-1K stays raw', () => {
    assert.equal(bytes(512), '512 B');
    assert.equal(bytes(4300), '4.2 KB');
    assert.equal(bytes(120000), '117.2 KB');
    assert.equal(bytes(null), DASH);
  });

  test('trunc collapses whitespace and marks the cut', () => {
    assert.equal(trunc('a  b\nc', 40), 'a b c');
    assert.equal(trunc('abcdefghij', 5), 'abcd…');
    assert.equal(trunc('abcde', 5), 'abcde', 'exact fit is not truncated');
    assert.equal(trunc(null, 5), DASH);
  });

  test('heading spells an empty list "none"', () => {
    assert.equal(heading('PROJECTS', 3), 'PROJECTS (3)');
    assert.equal(heading('PROJECTS', 0), 'PROJECTS (none)');
  });

  test('table pads every column but the last, and tolerates ragged rows', () => {
    assert.deepEqual(
      table([['a', 'longer', 'x'], ['bbbb', 'b', 'y']]),
      ['a     longer  x',
       'bbbb  b       y'],
    );
    assert.deepEqual(table([['a', 'b'], ['ccc']]), ['a    b', 'ccc']);
    assert.deepEqual(table([['1', 'x'], ['200', 'y']], ['r']), ['  1  x', '200  y']);
  });

  test('table never leaves trailing whitespace', () => {
    for (const line of table([['a', ''], ['bbb', '']])) {
      assert.equal(line, line.trimEnd(), `"${line}" has trailing whitespace`);
    }
  });

  test('indent skips blank lines', () => {
    assert.deepEqual(indent(['a', '', 'b'], 2), ['  a', '', '  b']);
  });

  test('block drops empties and collapses blank runs', () => {
    assert.equal(block('a', null, '', '', undefined, ['b', ''], 'c'), 'a\n\nb\n\nc');
    assert.equal(block('a', '', ''), 'a', 'no trailing blank lines');
  });
});

describe('deviations — the cold-when-non-default rule', () => {
  const spec = [
    { key: 'archived', default: false },
    { key: 'workspace', default: null, label: 'workspace' },
    { key: 'resetsAt', default: null, label: 'resets', fmt: ts },
    { key: 'isGitRepo', default: true, label: '! not a git repo' },
  ];

  test('a row at every default renders nothing', () => {
    assert.deepEqual(
      deviations({ archived: false, workspace: null, resetsAt: null, isGitRepo: true }, spec),
      [],
    );
  });

  test('each deviating field surfaces exactly once', () => {
    assert.deepEqual(
      deviations({ archived: true, workspace: 'personal', resetsAt: 1786001000000, isGitRepo: false }, spec),
      ['archived', 'workspace personal', 'resets 2026-08-06 07:23Z', '! not a git repo'],
    );
  });

  test('a boolean emits its label alone; a value is appended', () => {
    assert.deepEqual(deviations({ archived: true }, spec), ['archived']);
    assert.deepEqual(deviations({ workspace: 'ws' }, spec), ['workspace ws']);
  });

  test('an absent key is not a deviation', () => {
    assert.deepEqual(deviations({}, spec), [], 'undefined means "not reported", not "changed"');
  });
});

// ── per-tool renderers ─────────────────────────────────────────────────────

const WORKTREE = {
  parentProject: 'code-conductor',
  parentPath: '/w/cc-projects/code-conductor',
  worktreeName: 'code-conductor_worktree_dcd22e',
  worktreePath: '/w/cc-projects/code-conductor_worktree_dcd22e',
  branch: 'code-conductor/dcd22e',
  baseBranch: 'main',
  baseSha: '04746607c1b2',
  createdAt: '2026-08-06T09:12:00.000Z',
  sessions: { count: 3, archivedCount: 0, lastActivity: 1786000000000 },
  mergeStatus: { ahead: 2, behind: 0 },
};

describe('renderProjects', () => {
  test('a project at every default, and one deviating on both fields', () => {
    const out = renderProjects([
      {
        name: 'code-conductor',
        path: '/w/cc-projects/code-conductor',
        workspace: null,
        liveCount: 1,
        isGitRepo: true,
        worktrees: [WORKTREE],
        sessions: { count: 11, archivedCount: 1, lastActivity: 1786001000000 },
      },
      {
        name: 'notes',
        path: '/w/cc-projects/notes',
        workspace: 'personal',
        liveCount: 0,
        isGitRepo: false,
        worktrees: [],
        sessions: { count: 0, archivedCount: 0, lastActivity: 0 },
      },
    ]);
    assert.equal(out, [
      'PROJECTS (2)',
      '',
      '▸ code-conductor  /w/cc-projects/code-conductor',
      '  sessions 11 (archived 1)   last 2026-08-06 07:23Z',
      '  live 1',
      '  worktrees 1',
      '    code-conductor_worktree_dcd22e  br code-conductor/dcd22e  base main@04746607c1b2  ahead 2  behind 0  sessions 3  created 2026-08-06 09:12Z',
      '      /w/cc-projects/code-conductor_worktree_dcd22e',
      '',
      '▸ notes  /w/cc-projects/notes',
      '  workspace personal',
      '  ! not a git repo',
      '  sessions 0   last —',
      '  live 0',
      '  worktrees 0',
    ].join('\n'));
  });

  // The same `← base` marker renderWorktrees carries. Without it a chain is
  // invisible on list_projects — the conductor's primary recon call — because a
  // row shows only its base BRANCH.
  test('a derived worktree row names the worktree it is based on', () => {
    const out = renderProjects([{
      name: 'code-conductor', path: '/w/cc-projects/code-conductor', workspace: null,
      liveCount: 0, isGitRepo: true,
      worktrees: [
        WORKTREE,
        { ...WORKTREE,
          worktreeName: 'code-conductor_worktree_task',
          worktreePath: '/w/cc-projects/code-conductor_worktree_task',
          branch: 'code-conductor/task',
          baseBranch: 'code-conductor/dcd22e',
          baseWorktree: 'code-conductor_worktree_dcd22e' },
      ],
      sessions: { count: 0, archivedCount: 0, lastActivity: 0 },
    }]);
    assert.match(out, /base code-conductor\/dcd22e@04746607c1b2 ← code-conductor_worktree_dcd22e/);
    // A root-based row is untouched — no dangling arrow.
    const rootRow = out.split('\n').find(l => l.includes('code-conductor_worktree_dcd22e  br'));
    assert.ok(!rootRow.includes('←'), rootRow);
  });

  test('neither cold worktree key reaches the text', () => {
    // Sentinel parent values that share no substring with any hot field, so a
    // leak of either cold key is unambiguous.
    const out = renderProjects([{
      name: 'p', path: '/p', workspace: null, liveCount: 0, isGitRepo: true,
      worktrees: [{ ...WORKTREE, parentProject: 'COLD_PARENT', parentPath: '/COLD_PARENT_PATH' }],
      sessions: { count: 0, archivedCount: 0, lastActivity: 0 },
    }]);
    assert.ok(!out.includes('COLD_PARENT'), 'parentProject/parentPath are dropped here — the project header carries them');
  });

  test('an adopted project is tagged external; an in-root one is byte-identical to today', () => {
    const row = (extra) => ({
      name: 'p', path: '/anywhere/p', workspace: null, liveCount: 0, isGitRepo: true,
      worktrees: [], sessions: { count: 0, archivedCount: 0, lastActivity: 0 }, ...extra,
    });
    const baseline = [
      'PROJECTS (1)',
      '',
      '▸ p  /anywhere/p',
      '  sessions 0   last —',
      '  live 0',
      '  worktrees 0',
    ].join('\n');
    // A deviant declared with the wrong default would tag every project.
    assert.equal(renderProjects([row({ external: false })]), baseline);
    assert.equal(renderProjects([row({})]), baseline, 'an absent field is still no news');
    assert.equal(renderProjects([row({ external: true })]), [
      'PROJECTS (1)',
      '',
      '▸ p  /anywhere/p',
      '  external',
      '  sessions 0   last —',
      '  live 0',
      '  worktrees 0',
    ].join('\n'));
  });

  test('a project on another system names it and its path there; local is silent', () => {
    const row = (extra) => ({
      name: 'p', path: '/anywhere/p', workspace: null, liveCount: 0, isGitRepo: true,
      worktrees: [], sessions: { count: 0, archivedCount: 0, lastActivity: 0 }, ...extra,
    });
    const baseline = [
      'PROJECTS (1)',
      '',
      '▸ p  /anywhere/p',
      '  sessions 0   last —',
      '  live 0',
      '  worktrees 0',
    ].join('\n');
    // `local` carries no news — the deviant default. Absence of the fields must
    // read the same, because absence of the record field IS local and most
    // projects have no record at all.
    assert.equal(renderProjects([row({ system: 'local', systemPath: null })]), baseline);
    assert.equal(renderProjects([row({})]), baseline, 'an absent field is still no news');
    // A remote one says WHICH system and WHERE on it — the `▸` header path is a
    // cc-side path and does not carry the second fact.
    assert.equal(renderProjects([row({ system: 'prod-box', systemPath: '/app' })]), [
      'PROJECTS (1)',
      '',
      '▸ p  /anywhere/p',
      '  system prod-box',
      '  systemPath /app',
      '  sessions 0   last —',
      '  live 0',
      '  worktrees 0',
    ].join('\n'));
  });

  test('an empty root still names itself', () => {
    assert.equal(renderProjects([]), 'PROJECTS (none)');
  });

  test('an unknown ahead/behind reads as ? rather than a number', () => {
    const out = renderProjects([{
      name: 'p', path: '/p', workspace: null, liveCount: 0, isGitRepo: true,
      worktrees: [{ ...WORKTREE, mergeStatus: { ahead: null, behind: null } }],
      sessions: { count: 0, archivedCount: 0, lastActivity: 0 },
    }]);
    assert.match(out, /ahead \?  behind \?/);
  });

  test('live is a count — no worker is named here', () => {
    // The whole point of the split: naming workers is list_sessions' job, and
    // printing ids in both places made them look inconsistent whenever one
    // exited between the calls. A bare handle on its own line is the shape that
    // must never come back.
    const out = renderProjects([{
      name: 'p', path: '/p', workspace: null, liveCount: 3, isGitRepo: true,
      worktrees: [], sessions: { count: 0, archivedCount: 0, lastActivity: 0 },
      // Present in the payload but must not reach the text.
      sessionIds: [SID_A, SID_B],
    }]);
    assert.match(out, /^ {2}live 3$/m);
    assert.ok(!out.includes(SID_A) && !out.includes(SID_B), 'no sessionId may reach a project block');
    assert.equal(out.split('\n').filter(l => /^\s+[0-9a-f-]{36}$/.test(l)).length, 0,
      'a bare-uuid line is the exact shape this change removed');
  });

  test('a missing liveCount reads as absent, not as a silent zero', () => {
    // Fail loudly: a handler that stops supplying the count must not look like
    // a project with nobody working on it.
    const out = renderProjects([{
      name: 'p', path: '/p', workspace: null, liveCount: null, isGitRepo: true,
      worktrees: [], sessions: { count: 0, archivedCount: 0, lastActivity: 0 },
    }]);
    assert.match(out, /^ {2}live —$/m);
  });
});

const INSTANCE = {
  sessionId: SID_A,
  project: 'code-conductor',
  cwd: '/w/cc-projects/code-conductor_worktree_dcd22e',
  worktree: 'code-conductor_worktree_dcd22e',
  status: 'idle',
  displayStatus: 'running',
  activeAgentTasks: 2,
  mode: 'code',
  effort: 'high',
  thinking: 'adaptive',
  backend: 'claude',
  model: 'claude-opus-5',
  contextWindowTokens: 200000,
  pid: 4881,
  temp: false,
  conducted: false,
  debug: false,
  firstPrompt: 'Do the thing',
  title: 'Recon read tools plain-text rendering',
  createdAt: '2026-08-06T09:00:00.000Z',
  lastResponseAt: 1786001000000,
  queuedCount: 0,
  autoResumeAt: null,
  overageActive: false,
  overageResetsAt: null,
  awaitingWake: true,
  playbook: 'solo',
  stage: 'implement',
};

// One SessionGroup in the shape renderSessions takes (src/mcp/readRenderers.ts).
const grp = (over = {}) => ({
  project: 'code-conductor', worktree: null, path: '/w/cc-projects/code-conductor',
  branch: 'main', mergeStatus: null, live: [], inactive: [], archivedCount: 0, ...over,
});
// A stopped session as the handler hands it over: a SessionRow plus the
// playbook join and the EFFECTIVE resume mode.
const stoppedRow = (over = {}) => ({
  sessionId: SID_B, firstPrompt: 'Draft release notes', title: null,
  conducted: false, temp: false, archived: false, lastActivity: 1786001000000, size: 4300,
  playbook: null, stage: null, resumeMode: 'plan', ...over,
});
const liveOnly = (rows, opts) => renderSessions([grp({ live: rows })], opts);

describe('renderSessions — live rows', () => {
  test('a worker at every default renders no flags line', () => {
    assert.equal(liveOnly([INSTANCE]), [
      'SESSIONS (live 1 · inactive 0 · archived 0)',
      '',
      '▸ code-conductor  /w/cc-projects/code-conductor   live 1 · inactive 0 · archived 0',
      '  main checkout  br main   live 1 · inactive 0 · archived 0',
      `    [1] LIVE ${SID_A}`,
      '        status idle   display running   agents 2   queued 0   awaiting-wake yes',
      '        project code-conductor   worktree code-conductor_worktree_dcd22e',
      '        cwd /w/cc-projects/code-conductor_worktree_dcd22e',
      '        mode code   effort high   thinking adaptive   model claude/claude-opus-5',
      '        playbook solo / implement',
      '        title Recon read tools plain-text rendering',
      '        last 2026-08-06 07:23Z',
    ].join('\n'));
  });

  test('every deviating field surfaces on the flags line', () => {
    const out = liveOnly([{
      ...INSTANCE,
      temp: true, conducted: true, debug: true,
      overageActive: true, overageResetsAt: 1786020000000, autoResumeAt: 1786021000000,
    }]);
    assert.match(out, /^ {8}flags temp {2}conducted {2}debug {2}OVERAGE {2}overage-resets 2026-08-06 12:40Z {2}auto-resume 2026-08-06 12:56Z$/m);
  });

  test('firstPrompt stands in only when there is no title', () => {
    assert.ok(!liveOnly([INSTANCE]).includes('Do the thing'), 'firstPrompt is redundant beside a title');
    assert.match(liveOnly([{ ...INSTANCE, title: null }]), /title — {3}first Do the thing/);
  });

  test('worktree is a WorktreeMeta object — the text shows its name, not [object Object]', () => {
    // InstanceSummary.worktree is the whole meta object plus a
    // postWorktreeCreate report (src/instances.ts), unlike every other tool
    // here where `worktree` is a bare name.
    const out = liveOnly([{
      ...INSTANCE,
      worktree: {
        worktreeName: 'demo_worktree_ab12', branch: 'demo/ab12', baseBranch: 'main',
        baseSha: 'abc1234', postWorktreeCreate: { ran: true, output: 'noise' },
      },
    }]);
    assert.match(out, /worktree demo_worktree_ab12$/m);
    assert.ok(!out.includes('[object Object]'));
  });

  test('a live row is marked LIVE so it cannot be read as a stopped session', () => {
    assert.match(liveOnly([INSTANCE]), new RegExp(`^ {4}\\[1\\] LIVE ${SID_A}$`, 'm'));
  });

  test('an untracked worker still renders the playbook line, as absent', () => {
    assert.match(liveOnly([{ ...INSTANCE, playbook: null, stage: null }]),
      /^ {8}playbook — \/ —$/m);
  });

  test('the conductor own-session check reads cwd straight off the text', () => {
    // conventions/conductor/core.md tells the conductor to identify itself by
    // the row whose cwd ends in .conduct. Dropping cwd would break it silently.
    const out = liveOnly([{ ...INSTANCE, project: '.conduct', worktree: null, cwd: '/w/cc-projects/.conduct' }]);
    assert.match(out, /^ {8}cwd \/w\/cc-projects\/\.conduct$/m);
  });

  test('nothing anywhere', () => {
    assert.equal(renderSessions([]), 'SESSIONS (live 0 · inactive 0 · archived 0)');
  });

  test('a filter is echoed on the heading, so an empty result is not read as an idle fleet', () => {
    assert.equal(renderSessions([], { project: 'code-conductor' }),
      'SESSIONS (live 0 · inactive 0 · archived 0)  project code-conductor');
    assert.match(liveOnly([INSTANCE], { project: 'code-conductor' }),
      /^SESSIONS \(live 1 · inactive 0 · archived 0\) {2}project code-conductor$/m);
    // Unfiltered stays exactly as it was.
    assert.match(liveOnly([INSTANCE]), /^SESSIONS \(live 1 · inactive 0 · archived 0\)$/m);
  });
});

describe('renderSessions — inactive rows, grouping and archived', () => {
  test('an inactive session is one short line, not a worker block padded with dashes', () => {
    // A SessionRow has no status/effort/model. Rendering it in the live 7-line
    // shape would claim those were looked up and came back empty; the reader
    // must be able to tell the two apart at a glance.
    assert.equal(renderSessions([grp({ live: [INSTANCE], inactive: [stoppedRow({ conducted: true, temp: true })] })]), [
      'SESSIONS (live 1 · inactive 1 · archived 0)',
      '',
      '▸ code-conductor  /w/cc-projects/code-conductor   live 1 · inactive 1 · archived 0',
      '  main checkout  br main   live 1 · inactive 1 · archived 0',
      `    [1] LIVE ${SID_A}`,
      '        status idle   display running   agents 2   queued 0   awaiting-wake yes',
      '        project code-conductor   worktree code-conductor_worktree_dcd22e',
      '        cwd /w/cc-projects/code-conductor_worktree_dcd22e',
      '        mode code   effort high   thinking adaptive   model claude/claude-opus-5',
      '        playbook solo / implement',
      '        title Recon read tools plain-text rendering',
      '        last 2026-08-06 07:23Z',
      '',
      `    ${SID_B}  2026-08-06 07:23Z  —  conducted,temp  Draft release notes`,
    ].join('\n'));
  });

  test('an inactive row claims no runtime state, and no size', () => {
    const out = renderSessions([grp({ inactive: [stoppedRow({ title: 'T' })] })]);
    for (const claim of ['status ', 'mode ', 'display ', 'awaiting-wake ', 'effort ']) {
      assert.ok(!out.includes(claim), `an inactive row must not render "${claim}" — there is no process to read it from:\n${out}`);
    }
    assert.ok(!/\d+(\.\d+)? (B|KB|MB)/.test(out), `size was dropped from the inactive row:\n${out}`);
  });

  test('a playbook-tracked stopped session shows where it stopped', () => {
    const out = renderSessions([grp({ inactive: [stoppedRow({ playbook: 'solo', stage: 'review' })] })]);
    assert.match(out, /solo\/review/);
  });

  test('inactive rows render in the order given, and every one of them', () => {
    // Ordering is the caller's (newest first by lastActivity); the renderer must not
    // reorder or drop. Two rows minimum — one row cannot detect either bug.
    const out = renderSessions([grp({ inactive: [
      stoppedRow({ sessionId: SID_A, title: 'newest', lastActivity: 1786001000000 }),
      stoppedRow({ sessionId: SID_B, title: 'older', lastActivity: 1785900000000 }),
    ] })]);
    const lines = out.split('\n').filter(l => l.includes('newest') || l.includes('older'));
    assert.equal(lines.length, 2, 'both rows must render');
    assert.ok(lines[0].includes('newest') && lines[1].includes('older'), `given order must be preserved:\n${out}`);
  });

  test('archived collapses to a per-group count and never silently vanishes', () => {
    const out = renderSessions([grp({ inactive: [stoppedRow()], archivedCount: 51 })]);
    assert.match(out, /^ {4}\+51 archived \(includeArchived:true to list\)$/m);
    assert.match(out, /live 0 · inactive 1 · archived 51/);
  });

  test('an expanded archived row is flagged as archived', () => {
    const out = renderSessions([grp({ inactive: [stoppedRow({ archived: true })] })]);
    assert.match(out, /archived/);
  });

  test('expanding archived drops the call to action but keeps the count', () => {
    // The shape the handler actually produces under includeArchived:true —
    // archived rows present AND archivedCount non-zero, because the count is
    // taken before the filter. The two states were previously only ever pinned
    // apart (a count with no rows, or a row with a zero count), so nothing
    // caught the combination printing "+51 archived (includeArchived:true to
    // list)" underneath the 51 rows it was offering to reveal.
    const archivedRows = [
      stoppedRow({ sessionId: SID_A, title: 'old one', archived: true }),
      stoppedRow({ sessionId: SID_B, title: 'old two', archived: true }),
    ];
    const out = renderSessions([grp({ inactive: archivedRows, archivedCount: 2 })], { expanded: true });
    assert.ok(!out.includes('includeArchived:true to list'),
      `the rows are already listed — do not invite a flag the caller already passed:\n${out}`);
    assert.match(out, /live 0 · inactive 2 · archived 2/,
      'the header count stays: it is right in both forms');
    assert.ok(out.includes('old one') && out.includes('old two'), 'the rows themselves still render');
  });

  test('the call to action still prints when archived is collapsed', () => {
    // The converse, so the guard cannot degrade into "never show it".
    const out = renderSessions([grp({ inactive: [stoppedRow()], archivedCount: 2 })], { expanded: false });
    assert.match(out, /^ {4}\+2 archived \(includeArchived:true to list\)$/m);
  });

  test('the main checkout leads its project, then worktrees, each with its own header', () => {
    const out = renderSessions([
      grp({ inactive: [stoppedRow({ title: 'on main' })] }),
      grp({ worktree: 'cc_worktree_ab12', path: '/w/cc-projects/cc_worktree_ab12',
        branch: 'cc/ab12', mergeStatus: { ahead: 3, behind: 0 },
        inactive: [stoppedRow({ sessionId: SID_A, title: 'on wt' })], archivedCount: 2 }),
    ]);
    const heads = out.split('\n').filter(l => /^ {2}(main checkout|worktree )/.test(l));
    assert.equal(heads.length, 2);
    // The main checkout carries NO divergence: its number would be vs the
    // remote upstream, a different question from the worktree's vs-base.
    assert.match(heads[0], /^ {2}main checkout {2}br main {3}live 0 · inactive 1 · archived 0$/);
    assert.ok(!/[↑↓]/.test(heads[0]), 'a main checkout must not show a divergence number');
    assert.match(heads[1], /^ {2}worktree cc_worktree_ab12 {2}br cc\/ab12 {3}↑3 ↓0 vs base {3}live 0 · inactive 1 · archived 2$/);
    assert.ok(out.indexOf('on main') < out.indexOf('on wt'), 'the main checkout must come first');
    assert.match(out, /^ {4}\/w\/cc-projects\/cc_worktree_ab12$/m, "a worktree's own path must be reachable");
  });

  test('the project header sums every group under it', () => {
    const out = renderSessions([
      grp({ live: [INSTANCE], inactive: [stoppedRow()], archivedCount: 51 }),
      grp({ worktree: 'w', path: '/w/w', branch: 'b', inactive: [stoppedRow({ sessionId: SID_A })], archivedCount: 2 }),
    ]);
    assert.match(out, /^▸ code-conductor {2}\/w\/cc-projects\/code-conductor {3}live 1 · inactive 2 · archived 53$/m);
    assert.match(out, /^SESSIONS \(live 1 · inactive 2 · archived 53\)$/m);
  });

  test('two projects each get their own header block', () => {
    const out = renderSessions([
      grp({ project: 'aaa', path: '/w/aaa', inactive: [stoppedRow({ title: 'in aaa' })] }),
      grp({ project: 'zzz', path: '/w/zzz', inactive: [stoppedRow({ sessionId: SID_A, title: 'in zzz' })] }),
    ]);
    assert.equal(out.split('\n').filter(l => l.startsWith('▸')).length, 2);
    assert.ok(out.indexOf('in aaa') < out.indexOf('in zzz'));
  });
});

describe('renderSessions — the resumes-hot safety flag', () => {
  // The flag reads off the EFFECTIVE resume mode, so "no record" must still
  // flag: an unrecorded session resumes in bypassPermissions. A row that
  // resumes hot and shows no flag is the defect this pins.
  test('an unrecorded session — effective bypassPermissions — is flagged', () => {
    const out = renderSessions([grp({ inactive: [stoppedRow({ resumeMode: 'bypassPermissions' })] })]);
    assert.match(out, /resumes-hot/,
      'a session with no recorded mode resumes hot and MUST say so');
  });

  test('a recorded plan session is not flagged', () => {
    const out = renderSessions([grp({ inactive: [stoppedRow({ resumeMode: 'plan' })] })]);
    assert.ok(!out.includes('resumes-hot'), `plan does not resume hot:\n${out}`);
  });

  test('ask is gated, so it is not hot either', () => {
    const out = renderSessions([grp({ inactive: [stoppedRow({ resumeMode: 'ask' })] })]);
    assert.ok(!out.includes('resumes-hot'));
  });

  test('the flag joins the same flags cell as temp/conducted', () => {
    const out = renderSessions([grp({ inactive: [stoppedRow({ temp: true, resumeMode: 'bypassPermissions' })] })]);
    assert.match(out, /temp,resumes-hot/);
  });
});

describe('renderSession (describe_session)', () => {
  // Both branches reuse list_sessions' own row renderers, so what is pinned
  // here is the WRAPPER: the header, which branch renders which row shape, and
  // where the location block goes.
  test('a live session is the same LIVE worker block, under a live header', () => {
    assert.equal(renderSession({ sessionId: SID_A, live: INSTANCE }), [
      `SESSION ${SID_A}   live`,
      '',
      `[1] LIVE ${SID_A}`,
      '    status idle   display running   agents 2   queued 0   awaiting-wake yes',
      '    project code-conductor   worktree code-conductor_worktree_dcd22e',
      '    cwd /w/cc-projects/code-conductor_worktree_dcd22e',
      '    mode code   effort high   thinking adaptive   model claude/claude-opus-5',
      '    playbook solo / implement',
      '    title Recon read tools plain-text rendering',
      '    last 2026-08-06 07:23Z',
    ].join('\n'));
  });

  test('a retired session is the single session line, under the location block', () => {
    assert.equal(renderSession({
      sessionId: SID_B,
      project: 'code-conductor',
      worktree: 'code-conductor_worktree_dcd22e',
      path: '/w/cc-projects/code-conductor_worktree_dcd22e',
      retired: stoppedRow({ playbook: 'relay', stage: 'implement', conducted: true, temp: true,
        resumeMode: 'bypassPermissions' }),
    }), [
      `SESSION ${SID_B}   retired`,
      '    project code-conductor   worktree code-conductor_worktree_dcd22e',
      '    path /w/cc-projects/code-conductor_worktree_dcd22e',
      '',
      `${SID_B}  2026-08-06 07:23Z  relay/implement  conducted,temp,resumes-hot  Draft release notes`,
    ].join('\n'));
  });

  test('an archived session is still described, and says so', () => {
    const out = renderSession({
      sessionId: SID_B, project: 'code-conductor', worktree: null, path: '/w/cc-projects/code-conductor',
      retired: stoppedRow({ archived: true }),
    });
    assert.equal(out, [
      `SESSION ${SID_B}   retired`,
      '    project code-conductor   worktree —',
      '    path /w/cc-projects/code-conductor',
      '',
      `${SID_B}  2026-08-06 07:23Z  —  archived  Draft release notes`,
    ].join('\n'));
  });

  test('the location block is on the retired branch only — the live block already carries it', () => {
    // Hoisting project/worktree/cwd into the live header would print them
    // twice; leaving them off the retired branch would drop them entirely,
    // since inactiveRows has no location columns and there is no group header.
    const live = renderSession({ sessionId: SID_A, live: INSTANCE });
    assert.equal(live.split('\n').filter(l => /^ +project /.test(l)).length, 1,
      'the live worker block carries the one and only project/worktree line');
    assert.ok(!/^ +path /m.test(live),
      'the retired branch\'s `path` line must not appear on the live branch, which renders `cwd`');
    assert.match(live, /^ {4}cwd \/w\/cc-projects\/code-conductor_worktree_dcd22e$/m);
    const retired = renderSession({ sessionId: SID_B, project: 'p', worktree: null, path: '/p',
      retired: stoppedRow() });
    assert.match(retired, /^ {4}project p {3}worktree —$/m);
    assert.match(retired, /^ {4}path \/p$/m);
  });
});

describe('renderWorktrees', () => {
  // parentProject is row-invariant (a worktree records the ROOT project even when
  // based on another worktree) so it heads the block. parentPath is NOT — see the
  // derived-row test below — so it is not rendered at all.
  test('project renders once as a header, path under each row', () => {
    assert.equal(renderWorktrees([
      { worktree: 'demo_worktree_ab12', parentProject: 'demo', parentPath: '/w/cc-projects/demo',
        worktreePath: '/w/cc-projects/demo_worktree_ab12', branch: 'demo/ab12',
        baseBranch: 'main', baseSha: 'abc1234', createdAt: '2026-08-01T10:00:00.000Z' },
      { worktree: 'demo_worktree_c9', parentProject: 'demo', parentPath: '/w/cc-projects/demo',
        worktreePath: '/w/cc-projects/demo_worktree_c9', branch: 'demo/c9',
        baseBranch: 'main', baseSha: 'def5678', createdAt: '2026-08-02T11:30:00.000Z' },
    ]), [
      'WORKTREES (2) — demo',
      '',
      'demo_worktree_ab12  br demo/ab12  base main@abc1234  created 2026-08-01 10:00Z',
      '  /w/cc-projects/demo_worktree_ab12',
      'demo_worktree_c9    br demo/c9    base main@def5678  created 2026-08-02 11:30Z',
      '  /w/cc-projects/demo_worktree_c9',
    ].join('\n'));
  });

  // The rows here have DIFFERENT parentPaths, which is exactly why the header
  // can't hoist one: the derived row's parent is the feature's checkout.
  test('a derived worktree names the worktree it is based on', () => {
    assert.equal(renderWorktrees([
      { worktree: 'demo_worktree_auth', parentProject: 'demo', parentPath: '/w/cc-projects/demo',
        worktreePath: '/w/cc-projects/demo_worktree_auth', branch: 'code-conductor/auth',
        baseBranch: 'main', baseSha: 'abc1234', createdAt: '2026-08-01T10:00:00.000Z' },
      { worktree: 'demo_worktree_c9', parentProject: 'demo',
        parentPath: '/w/cc-projects/demo_worktree_auth',
        worktreePath: '/w/cc-projects/demo_worktree_c9', branch: 'demo/c9',
        baseBranch: 'code-conductor/auth', baseSha: 'def5678',
        baseWorktree: 'demo_worktree_auth', createdAt: '2026-08-02T11:30:00.000Z' },
    ]), [
      'WORKTREES (2) — demo',
      '',
      'demo_worktree_auth  br code-conductor/auth  base main@abc1234                                      created 2026-08-01 10:00Z',
      '  /w/cc-projects/demo_worktree_auth',
      'demo_worktree_c9    br demo/c9              base code-conductor/auth@def5678 ← demo_worktree_auth  created 2026-08-02 11:30Z',
      '  /w/cc-projects/demo_worktree_c9',
    ].join('\n'));
  });

  test('no worktrees', () => {
    assert.equal(renderWorktrees([]), 'WORKTREES (none)');
  });
});


describe('renderProjects unbornHead', () => {
  const row = (over) => ({
    name: 'p', path: '/w/p', workspace: null, liveCount: 0,
    isGitRepo: true, worktrees: [],
    sessions: { count: 0, archivedCount: 0, lastActivity: 0 },
    ...over,
  });

  test('unbornHead:true emits the no-commits deviant line', () => {
    assert.match(renderProjects([row({ unbornHead: true })]),
      /^ {2}! no commits yet — a worktree needs a first commit$/m);
  });

  test('unbornHead:false and an absent key both render nothing new', () => {
    const absent = renderProjects([row({})]);
    assert.equal(renderProjects([row({ unbornHead: false })]), absent);
    assert.ok(!absent.includes('no commits yet'));
  });
});

describe('renderProjectStatus', () => {
  test('an unborn HEAD renders no-commits-yet instead of a blank HEAD', () => {
    const out = renderProjectStatus({
      project: 'fresh', worktree: null, cwd: '/w/fresh',
      files: [], isGitRepo: true, unbornHead: true, branch: 'main',
      head: null, dirty: [], recentCommits: [],
    });
    assert.match(out, /^branch main$/m);
    assert.match(out, /^HEAD — no commits yet$/m);
    assert.ok(!/^HEAD — —$/m.test(out));
    assert.ok(!out.includes('! not a git repo'));
    // DIRTY/COMMITS still render — both are meaningful on an unborn repo.
    assert.match(out, /^DIRTY \(none\)$/m);
    assert.match(out, /^COMMITS \(none\)$/m);
  });

  test('a worktree carries base, ahead/behind and a diffstat', () => {
    assert.equal(renderProjectStatus({
      project: 'demo', worktree: 'demo_worktree_ab12', cwd: '/w/cc-projects/demo_worktree_ab12',
      files: [{ name: 'src', kind: 'dir' }, { name: 'package.json', kind: 'file' }],
      isGitRepo: true, branch: 'demo/ab12',
      head: { sha: '04746607c1b2ab', subject: 'Merge branch x' },
      dirty: ['M src/a.ts', '?? tmp.txt'], dirtyTruncated: false,
      recentCommits: ['0474660 Merge branch x', 'fb31e76 Trim pointer'],
      baseBranch: 'main', baseSha: 'abc1234', mergeStatus: { ahead: 2, behind: 0 },
      diffStat: 'src/a.ts | 12 ++++--\n 1 file changed',
    }), [
      'demo  worktree demo_worktree_ab12',
      'cwd /w/cc-projects/demo_worktree_ab12',
      'branch demo/ab12',
      'HEAD 04746607c1b2ab Merge branch x',
      'base main@abc1234   ahead 2  behind 0',
      '',
      'FILES (2)',
      '  src/  package.json',
      '',
      'DIRTY (2)',
      '  M src/a.ts',
      '  ?? tmp.txt',
      '',
      'DIFFSTAT (vs main)',
      '  src/a.ts | 12 ++++--',
      '   1 file changed',
      '',
      'COMMITS (2)',
      '  0474660 Merge branch x',
      '  fb31e76 Trim pointer',
    ].join('\n'));
  });

  test('a non-repo says so and stops after FILES', () => {
    assert.equal(renderProjectStatus({
      project: 'plain', worktree: null, cwd: '/w/cc-projects/plain',
      files: [{ name: 'notes.md', kind: 'file' }], isGitRepo: false,
    }), [
      'plain',
      'cwd /w/cc-projects/plain',
      '! not a git repo',
      '',
      'FILES (1)',
      '  notes.md',
    ].join('\n'));
  });

  test('a capped dirty list reports both counts', () => {
    const out = renderProjectStatus({
      project: 'p', worktree: null, cwd: '/p', files: [], isGitRepo: true,
      branch: 'main', head: { sha: 'a', subject: 's' },
      dirty: ['M a', 'M b'], dirtyTotal: 812, dirtyTruncated: true, recentCommits: [],
    });
    assert.match(out, /^DIRTY \(2 of 812 — truncated\)$/m,
      'the cap must never read as "only 2 files changed"');
  });

  test('logLimit:0 omits the commits section entirely', () => {
    const out = renderProjectStatus({
      project: 'p', worktree: null, cwd: '/p', files: [], isGitRepo: true,
      branch: 'main', head: { sha: 'a', subject: 's' }, dirty: [], dirtyTruncated: false,
    });
    assert.ok(!out.includes('COMMITS'), 'no recentCommits key ⇒ no section');
  });

  test('detached HEAD renders a dash, not a crash', () => {
    const out = renderProjectStatus({
      project: 'p', worktree: null, cwd: '/p', files: [], isGitRepo: true,
      branch: null, head: null, dirty: [], dirtyTruncated: false, recentCommits: [],
    });
    assert.match(out, /^branch —$/m);
    assert.match(out, /^HEAD — —$/m);
  });
});

// ── handles vs informational values ────────────────────────────────────────

describe('handles and shas', () => {
  const FULL_SHA = '047466034cf469b50fa23c2ded41234d058a3c1c';

  test('sessionIds and absolute paths survive at full length', () => {
    // The text is the whole result, so an abbreviated handle is unrecoverable.
    const projects = renderProjects([{
      name: 'p', path: '/very/long/absolute/path/to/a/project/root/p', workspace: null,
      liveCount: 1, isGitRepo: true, worktrees: [WORKTREE],
      sessions: { count: 1, archivedCount: 0, lastActivity: 1 },
    }]);
    assert.ok(projects.includes('/very/long/absolute/path/to/a/project/root/p'));
    assert.ok(projects.includes(WORKTREE.worktreePath), 'worktree path must not be abbreviated');
    assert.ok(projects.includes(WORKTREE.branch), 'branch name must not be abbreviated');
    assert.ok(renderSessions([grp({ inactive: [stoppedRow({ sessionId: SID_A, title: 't' })] })]).includes(SID_A));
    assert.ok(liveOnly([INSTANCE]).includes(SID_A));
  });

  test('an empty baseSha still reads as absent, not as a bare @', () => {
    const out = renderWorktrees([{ worktree: 'w', parentProject: 'p', parentPath: '/p',
      worktreePath: '/w', branch: 'b', baseBranch: 'main', baseSha: '', createdAt: 0 }]);
    assert.match(out, /base main@—/, "'' must fall through to dash(), like every other absent value");
  });

  test('a baseSha is shortened to 12 — informational, not a handle', () => {
    const wt = { ...WORKTREE, baseSha: FULL_SHA };
    for (const out of [
      renderProjects([{ name: 'p', path: '/p', workspace: null, liveCount: 0, isGitRepo: true,
        worktrees: [wt], sessions: { count: 0, archivedCount: 0, lastActivity: 0 } }]),
      renderWorktrees([{ worktree: 'w', parentProject: 'p', parentPath: '/p', worktreePath: '/w',
        branch: 'b', baseBranch: 'main', baseSha: FULL_SHA, createdAt: 0 }]),
      renderProjectStatus({ project: 'p', worktree: 'w', cwd: '/w', files: [], isGitRepo: true,
        branch: 'b', head: { sha: FULL_SHA, subject: 's' }, dirty: [], dirtyTruncated: false,
        baseBranch: 'main', baseSha: FULL_SHA, mergeStatus: { ahead: 0, behind: 0 }, diffStat: '' }),
    ]) {
      assert.match(out, /base main@047466034cf4(\s|$)/m);
      assert.ok(!out.includes(`main@${FULL_SHA}`), 'the base sha must be shortened');
    }
  });

  test('project_status HEAD keeps the full sha — it is what you pass to git', () => {
    const out = renderProjectStatus({ project: 'p', worktree: null, cwd: '/p', files: [],
      isGitRepo: true, branch: 'b', head: { sha: FULL_SHA, subject: 's' },
      dirty: [], dirtyTruncated: false });
    assert.ok(out.includes(`HEAD ${FULL_SHA} s`));
  });
});

// ── allowlist → rendering binding ──────────────────────────────────────────
//
// The text is now the ONLY output channel, so the guards that defend the object
// key set (the doc-drift gate in mcp-conductor-view, the projection checks)
// defend nothing a caller can see. A field could be added to
// CONDUCTOR_VIEW_KEYS, to summary(), and to the tool description — passing every
// one of those — and still never be rendered. This binds the allowlist to the
// rendering itself, in the direction that now matters.
//
// It is deliberately FAIL-BY-DEFAULT: an unrecognised key lands in the
// sentinel-checked set and must show up in the output. Getting the polarity
// backwards (an opt-in "check these" list) would rebuild exactly the hole this
// closes, so the two exemption sets below are small, named, and asserted
// non-empty.

describe('list_sessions renders every allowlisted field', () => {
  // A value no renderer could produce on its own, unique per key.
  const sentinel = (k) => `«${k}»`;
  const ALL_KEYS = [...CONDUCTOR_VIEW_KEYS, ...LIST_ONLY_KEYS];

  // Deliberately dropped — see the header comment of src/mcp/readRenderers.ts.
  // Each MUST NOT appear; that is the other half of the binding.
  const DROPPED = ['pid', 'createdAt', 'contextWindowTokens', 'firstPrompt'];
  // Rendered as a fixed label rather than its value, so a sentinel can't be
  // looked for. Checked by its own assertion below instead.
  const LABEL_ONLY = ['awaitingWake'];
  // Everything else must appear verbatim. A NEW key falls in here by default.
  const BY_VALUE = ALL_KEYS.filter(k => !DROPPED.includes(k) && !LABEL_ONLY.includes(k));

  const sentinelRow = (over = {}) => ({
    ...Object.fromEntries(ALL_KEYS.map(k => [k, sentinel(k)])),
    awaitingWake: true,
    ...over,
  });

  test('the exemption sets are real, non-empty, and still name live keys', () => {
    assert.ok(CONDUCTOR_VIEW_KEYS.length > 20, 'vacuity guard: allowlist looks empty');
    assert.ok(DROPPED.length > 0, 'an empty DROPPED set would make this suite trivially pass');
    assert.ok(LABEL_ONLY.length > 0);
    for (const k of [...DROPPED, ...LABEL_ONLY]) {
      assert.ok(ALL_KEYS.includes(k), `'${k}' is exempted but no longer in the allowlist — stale entry`);
    }
    assert.ok(BY_VALUE.length >= 20, `only ${BY_VALUE.length} keys checked by value`);
  });

  // TWO surfaces, one binding: list_sessions' rendering and describe_session's
  // LIVE branch, which reuses instanceRows verbatim. The binding is therefore
  // structural — but naming the second target is what makes it FAIL-BY-DEFAULT
  // for describe_session too, rather than merely true today.
  const SURFACES = [
    ['renderSessions (list_sessions)', rows => liveOnly(rows)],
    ['renderSession (describe_session, live)',
      rows => renderSession({ sessionId: rows[0].sessionId, live: rows[0] })],
  ];

  test('every non-exempt allowlisted field reaches the text, on both live surfaces', () => {
    for (const [label, render] of SURFACES) {
      const out = render([sentinelRow()]);
      const missing = BY_VALUE.filter(k => !out.includes(sentinel(k)));
      assert.deepEqual(missing, [],
        `${label}: these allowlisted fields are never rendered — render them, `
        + `or add them to DROPPED with a justification in readRenderers.ts:\n${out}`);
    }
  });

  test('every deliberately-dropped field stays out of the text, on both live surfaces', () => {
    for (const [label, render] of SURFACES) {
      const out = render([sentinelRow()]);
      const leaked = DROPPED.filter(k => out.includes(sentinel(k)));
      assert.deepEqual(leaked, [], `${label}: a field listed as dropped is being rendered`);
    }
  });

  test('awaitingWake renders as a label, both ways', () => {
    assert.match(liveOnly([sentinelRow({ awaitingWake: true })]), /awaiting-wake yes/);
    assert.match(liveOnly([sentinelRow({ awaitingWake: false })]), /awaiting-wake no/);
  });

  test('firstPrompt is dropped only because a title is there to replace it', () => {
    // The one conditional exemption: with no title it MUST be rendered, so the
    // fact is never unreachable — it is superseded, not withheld.
    const out = liveOnly([sentinelRow({ title: null })]);
    assert.ok(out.includes(sentinel('firstPrompt')),
      'with no title, firstPrompt must stand in for it');
  });
});

// ── renderPlaybook (describe_playbook) ─────────────────────────────────────
//
// describe_playbook returns this rendering as its ENTIRE success result, so the
// bar is the same as for the recon tools: a fact absent here is a fact the
// conductor cannot get. The fixture below is built branch-by-branch on purpose —
// stage keys out of alphabetical order, both `at` values, both `workers` values,
// both `spawnable` values, a "*" entry beside allow/deny/pin, an empty
// `tools` map, a multi-line description, an unauthored one, and edges with and
// without `on`. Every one of those exists to kill a specific mutant; a fixture
// that exercised only the common shape would let a renderer that hardcodes
// `spawnable yes` or drops the "*" entry pass.

// >100 chars, multi-line, and its second paragraph begins with "tools " — the
// hazard the description label + deeper indent exist to defuse.
const STAGE_PROSE = 'Brief the worker, then wait for its sentinel before you treat the work as reviewable.\n'
  + '\n'
  + 'tools deny is not a field here — this is authored prose.';
// A run of TWO blank lines: block() would collapse it to one, so this pins that
// authored text is not routed through it.
const GRAPH_PROSE = 'Top line.\n\n\nAfter a blank run.';

const GRAPH = {
  id: 'demo',
  name: 'Demo — a graph',
  description: GRAPH_PROSE,
  entryStages: ['triage', 'fan'],
  stages: {
    // 'triage' before 'fan' — insertion order is NOT alphabetical order.
    triage: {
      needs: [],
      workers: 'one',
      tools: {
        '*': 'deny',
        spawn_instance: { pin: { mode: 'plan', createWorktree: true, label: null } },
        set_mode: 'allow',
      },
      spawnable: true,
      description: STAGE_PROSE,
    },
    fan: {
      needs: [
        { stage: 'triage', position: ['triage'], liveness: 'live' },
        { stage: 'triage', position: ['*'], liveness: 'any' },
      ],
      workers: 'many',
      tools: {},
      spawnable: false,
    },
    sink: {
      // A multi-member position list, so the join is exercised too.
      needs: [{ stage: 'fan', position: ['fan', 'sink'], liveness: 'retired' }],
      workers: 'one',
      tools: { '*': 'allow' },
      spawnable: false,
    },
  },
  // Three edges of TWO different widths on purpose: a two-stage graph can only
  // produce edge labels of equal length, which makes table()'s padding a no-op
  // and lets a plain join pass for it.
  transitions: [
    { from: 'triage', to: 'fan', via: 'approve_plan', description: 'Edge prose.' },
    { from: 'fan', to: 'triage', via: 'send_prompt' },
    { from: 'fan', to: 'sink', via: 'send_prompt' },
  ],
};

describe('renderPlaybook', () => {
  test('renders the whole graph', () => {
    assert.equal(renderPlaybook(GRAPH), [
      'PLAYBOOK demo',
      'name Demo — a graph',
      'entry triage, fan',
      '',
      'DESCRIPTION',
      '  Top line.',
      '',
      '',
      '  After a blank run.',
      '',
      'STAGES (3)',
      '▸ triage   workers one   spawnable yes',
      '    needs —',
      '    tools (3)',
      '      * deny',
      '      spawn_instance pin {"mode":"plan","createWorktree":true,"label":null}',
      '      set_mode allow',
      '    description',
      '      Brief the worker, then wait for its sentinel before you treat the work as reviewable.',
      '',
      '      tools deny is not a field here — this is authored prose.',
      '▸ fan   workers many   spawnable no',
      '    needs triage@live in triage, triage@any in *',
      '    tools (none)',
      '▸ sink   workers one   spawnable no',
      '    needs fan@retired in fan|sink',
      '    tools (1)',
      '      * allow',
      '',
      'TRANSITIONS (3)',
      '  triage → fan  via approve_plan',
      '    description',
      '      Edge prose.',
      '  fan → triage  via send_prompt',
      '  fan → sink    via send_prompt',
    ].join('\n'));
  });

  test('the via column is aligned across edges of differing width', () => {
    // table(), not a plain join: a reader scanning the column lands on the
    // driving tool on every row. `fan → sink` is shorter than the other two, so
    // its padding is the observable difference.
    const viaColumns = renderPlaybook(GRAPH).split('\n')
      .filter(l => / via /.test(l))
      .map(l => l.indexOf(' via '));
    assert.equal(viaColumns.length, 3);
    assert.deepEqual([...new Set(viaColumns)], [viaColumns[0]],
      'every edge must place `via` at the same column');
  });

  test('every tool in a stage policy map reaches the text, including the "*" fallback', () => {
    // Pins the whole map, not just its first entry: a renderer that dropped
    // `tools`, sliced it, or sorted away the authored order fails here. The "*"
    // key is spelled literally because it is the stage's fallback for every tool
    // it does not name — a reader who cannot see it cannot tell an allowlist
    // stage from a permissive one.
    const out = renderPlaybook(GRAPH);
    assert.match(out, /^ {4}tools \(3\)$/m, 'the count must match the map size');
    assert.match(out, /^ {6}\* deny$/m);
    assert.match(out, /^ {6}set_mode allow$/m);
    assert.match(out, /^ {6}spawn_instance pin /m);
  });

  test('a pin constraint renders every argument name AND value, typed', () => {
    // These are the argument values the gate enforces, so dropping one, or
    // rendering the map as [object Object]/"pin", would advertise a call that
    // then refuses ARG_PIN_CONFLICT. JSON spelling keeps "plan" distinct from
    // plan, true from "true", and null from absent.
    assert.match(renderPlaybook(GRAPH),
      /spawn_instance pin \{"mode":"plan","createWorktree":true,"label":null\}/);
  });

  test('every transition renders its own via', () => {
    // Both directions of the mutant: `via` hardcoded to send_prompt, and `via`
    // taken from a declared `on` only (which would blank the defaulted edge).
    const out = renderPlaybook(GRAPH);
    assert.match(out, /^ {2}triage → fan {2}via approve_plan$/m);
    assert.match(out, /^ {2}fan → triage {2}via send_prompt$/m);
  });

  test('an empty tools map or needs list renders (none) / —, never a blank', () => {
    // "this stage declares no policy" must stay distinguishable from "the
    // renderer dropped the field".
    const out = renderPlaybook(GRAPH);
    assert.match(out, /^ {4}tools \(none\)$/m);
    assert.match(out, /^ {4}needs —$/m);
  });

  test('an unauthored description emits no line at all', () => {
    // The absence semantics the JSON shape used to carry as key-absence: no
    // label, no —, and no "undefined"/"null" leaking into the prose slot.
    const out = renderPlaybook(GRAPH);
    const fan = out.slice(out.indexOf('▸ fan'), out.indexOf('TRANSITIONS'));
    assert.equal(/description/.test(fan), false, `an unauthored stage grew a description:\n${fan}`);
    const lastEdge = out.slice(out.indexOf('  fan → triage'));
    assert.equal(/description/.test(lastEdge), false, 'an unauthored edge grew a description');
    assert.equal(/undefined|null,|: null/.test(out.replace(/"label":null/, '')), false,
      'no absent field may render as a JS sentinel');
  });

  test('authored prose passes through verbatim — never truncated or reflowed', () => {
    // trunc(), a reflow, or block()'s blank-run collapsing would each silently
    // rewrite the one text a playbook author owns. Asserted on the body with the
    // rendering's indent removed, so only the author's own line structure is
    // compared.
    const out = renderPlaybook(GRAPH);
    const unindent = (s, n) => s.split('\n').map(l => l.slice(n)).join('\n');
    const stageBody = out.slice(out.indexOf('      Brief the worker'), out.indexOf('▸ fan') - 1);
    assert.equal(unindent(stageBody, 6), STAGE_PROSE);
    const graphBody = out.slice(out.indexOf('  Top line.'), out.indexOf('\n\nSTAGES'));
    assert.equal(unindent(graphBody, 2), GRAPH_PROSE);
  });

  test('an empty entryStages or transitions list still renders a readable line', () => {
    // Both are legal: no stage need declare spawn_instance, and a one-stage graph
    // has no edges. A bare `entry` line or `TRANSITIONS (0)` would read as a bug.
    const out = renderPlaybook({
      id: 'bare', name: 'Bare', description: 'x', entryStages: [],
      stages: { only: { needs: [], workers: 'one', tools: {}, spawnable: false } },
      transitions: [],
    });
    assert.match(out, /^entry —$/m);
    assert.match(out, /^TRANSITIONS \(none\)$/m);
  });

  // The guard that outlives this change. Every assertion above is a claim about
  // the payload AS IT EXISTS TODAY; this one is a claim about the schema, so a
  // field added to Stage/Transition/Playbook next month cannot vanish from the
  // tool's entire output with the suite still green. Reads the validator's own
  // allowlists (src/playbooks.ts) rather than a copy that would drift.
  describe('renderPlaybook renders every field the validator admits', () => {
    // Namespaced by group, because `description` is a key of all three: one
    // shared sentinel would let the playbook-level fill satisfy the stage and
    // transition checks too, and deleting either of those description blocks
    // from the renderer would leave this suite green — the exact vacuity this
    // test exists to prevent.
    const sentinel = (group, k) => `«${group}.${k}»`;
    // Rendered as their own value, so a sentinel can be looked for directly.
    const SCALARS = {
      playbook: ['id', 'name', 'description'],
      stage: ['workers', 'description'],
      transition: ['from', 'to', 'description'],
    };
    // Containers and renamed/derived fields, each covered by a named test above:
    // entryStages/stages/transitions by the full-graph string, needs by the
    // needs/— test, tools by the tools-map test, and `on` by the via test (the
    // payload carries it as the derived `via`, never under its schema name).
    const BY_DEDICATED_ASSERTION = {
      playbook: ['entryStages', 'stages', 'transitions'],
      stage: ['needs', 'tools'],
      transition: ['on'],
    };
    const SETS = { playbook: PLAYBOOK_KEYS, stage: STAGE_KEYS, transition: TRANSITION_KEYS };

    test('every schema key is accounted for as rendered-by-value or covered elsewhere', () => {
      for (const [group, keys] of Object.entries(SETS)) {
        assert.deepEqual(
          [...SCALARS[group], ...BY_DEDICATED_ASSERTION[group]].sort(),
          [...keys].sort(),
          `${group}: a schema key is in neither list — add it to renderPlaybook and to `
          + 'SCALARS, or justify it in BY_DEDICATED_ASSERTION');
      }
    });

    test('every by-value schema key reaches the text', () => {
      const fill = (group) => Object.fromEntries(SCALARS[group].map(k => [k, sentinel(group, k)]));
      const out = renderPlaybook({
        ...fill('playbook'),
        entryStages: ['s'],
        stages: { s: { ...fill('stage'), needs: [], tools: {}, spawnable: true } },
        transitions: [{ ...fill('transition'), via: 'send_prompt' }],
      });
      const all = Object.entries(SCALARS).flatMap(([group, keys]) => keys.map(k => [group, k]));
      const missing = all.filter(([g, k]) => !out.includes(sentinel(g, k))).map(([g, k]) => `${g}.${k}`);
      assert.deepEqual(missing, [],
        `these fields never reach the rendering — add them to renderPlaybook:\n${out}`);
    });

    test('the two derived fields the payload adds are rendered too', () => {
      // `spawnable` and `via` are computed by describePlaybook, so they are in no
      // schema key set and this suite would otherwise never look at them.
      const out = renderPlaybook(GRAPH);
      assert.match(out, /spawnable yes/);
      assert.match(out, /spawnable no/);
      assert.match(out, /via approve_plan/);
    });
  });
});
