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
  renderProjects, renderInstances, renderWorktrees, renderSessions, renderProjectStatus,
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
  sessions: { count: 3, archivedCount: 0, lastMtime: 1786000000000 },
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
        sessions: { count: 11, archivedCount: 1, lastMtime: 1786001000000 },
      },
      {
        name: 'notes',
        path: '/w/cc-projects/notes',
        workspace: 'personal',
        liveCount: 0,
        isGitRepo: false,
        worktrees: [],
        sessions: { count: 0, archivedCount: 0, lastMtime: 0 },
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

  test('neither cold worktree key reaches the text', () => {
    // Sentinel parent values that share no substring with any hot field, so a
    // leak of either cold key is unambiguous.
    const out = renderProjects([{
      name: 'p', path: '/p', workspace: null, liveCount: 0, isGitRepo: true,
      worktrees: [{ ...WORKTREE, parentProject: 'COLD_PARENT', parentPath: '/COLD_PARENT_PATH' }],
      sessions: { count: 0, archivedCount: 0, lastMtime: 0 },
    }]);
    assert.ok(!out.includes('COLD_PARENT'), 'parentProject/parentPath are dropped here — the project header carries them');
  });

  test('an empty root still names itself', () => {
    assert.equal(renderProjects([]), 'PROJECTS (none)');
  });

  test('an unknown ahead/behind reads as ? rather than a number', () => {
    const out = renderProjects([{
      name: 'p', path: '/p', workspace: null, liveCount: 0, isGitRepo: true,
      worktrees: [{ ...WORKTREE, mergeStatus: { ahead: null, behind: null } }],
      sessions: { count: 0, archivedCount: 0, lastMtime: 0 },
    }]);
    assert.match(out, /ahead \?  behind \?/);
  });

  test('live is a count — no worker is named here', () => {
    // The whole point of the split: naming workers is list_instances' job, and
    // printing ids in both places made them look inconsistent whenever one
    // exited between the calls. A bare handle on its own line is the shape that
    // must never come back.
    const out = renderProjects([{
      name: 'p', path: '/p', workspace: null, liveCount: 3, isGitRepo: true,
      worktrees: [], sessions: { count: 0, archivedCount: 0, lastMtime: 0 },
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
      worktrees: [], sessions: { count: 0, archivedCount: 0, lastMtime: 0 },
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
  hasIdleSubscriber: true,
  playbook: 'classic',
  stage: 'implement',
};

describe('renderInstances', () => {
  test('a worker at every default renders no flags line', () => {
    assert.equal(renderInstances([INSTANCE]), [
      'INSTANCES (1)',
      '',
      `[1] ${SID_A}`,
      '    status idle   display running   agents 2   queued 0   idle-sub yes',
      '    project code-conductor   worktree code-conductor_worktree_dcd22e',
      '    cwd /w/cc-projects/code-conductor_worktree_dcd22e',
      '    mode code   effort high   thinking adaptive   model claude/claude-opus-5',
      '    playbook classic / implement',
      '    title Recon read tools plain-text rendering',
      '    last 2026-08-06 07:23Z',
    ].join('\n'));
  });

  test('every deviating field surfaces on the flags line', () => {
    const out = renderInstances([{
      ...INSTANCE,
      temp: true, conducted: true, debug: true,
      overageActive: true, overageResetsAt: 1786020000000, autoResumeAt: 1786021000000,
    }]);
    assert.match(out, /^ {4}flags temp {2}conducted {2}debug {2}OVERAGE {2}overage-resets 2026-08-06 12:40Z {2}auto-resume 2026-08-06 12:56Z$/m);
  });

  test('firstPrompt stands in only when there is no title', () => {
    const titled = renderInstances([INSTANCE]);
    assert.ok(!titled.includes('Do the thing'), 'firstPrompt is redundant beside a title');
    const untitled = renderInstances([{ ...INSTANCE, title: null }]);
    assert.match(untitled, /title — {3}first Do the thing/);
  });

  test('worktree is a WorktreeMeta object — the text shows its name, not [object Object]', () => {
    // InstanceSummary.worktree is the whole meta object plus a
    // postWorktreeCreate report (src/instances.ts), unlike every other tool
    // here where `worktree` is a bare name.
    const out = renderInstances([{
      ...INSTANCE,
      worktree: {
        worktreeName: 'demo_worktree_ab12', branch: 'demo/ab12', baseBranch: 'main',
        baseSha: 'abc1234', postWorktreeCreate: { ran: true, output: 'noise' },
      },
    }]);
    assert.match(out, /worktree demo_worktree_ab12$/m);
    assert.ok(!out.includes('[object Object]'));
    assert.ok(!out.includes('noise'), 'the nested postWorktreeCreate report is not rendered');
  });

  test('an untracked worker reads as not-in-a-playbook, not as missing data', () => {
    assert.match(renderInstances([{ ...INSTANCE, playbook: null, stage: null }]),
      /playbook — \/ —/);
  });

  test('cwd is readable off the text — the self-identification check', () => {
    // conventions/conductor/core.md: "yours is the one whose cwd ends in .conduct".
    const out = renderInstances([{ ...INSTANCE, project: '.conduct', worktree: null, cwd: '/w/cc-projects/.conduct' }]);
    const line = out.split('\n').find(l => l.trim().startsWith('cwd '));
    assert.ok(line, 'every worker row must carry a cwd line');
    assert.ok(line.trim().endsWith('.conduct'), `cwd must be checkable for a .conduct suffix; got "${line}"`);
  });

  test('no live workers', () => {
    assert.equal(renderInstances([]), 'INSTANCES (none)');
  });

  test('nothing is stopped — no INACTIVE section at all', () => {
    // The common case must not grow a heading for an empty set.
    assert.ok(!renderInstances([INSTANCE]).includes('INACTIVE'));
    assert.ok(!renderInstances([INSTANCE], { inactive: [] }).includes('INACTIVE'));
  });

  test('an inactive session is one short line, not a worker block padded with dashes', () => {
    // A SessionRow has no status/mode/model/playbook. Rendering it in the live
    // 7-line shape would claim those were looked up and came back empty; the
    // reader must be able to tell the two apart at a glance.
    const stopped = {
      sessionId: SID_B, firstPrompt: 'Draft release notes', title: null,
      conducted: true, temp: true, archived: false,
      mtime: 1786001000000, size: 4300,
      project: 'code-conductor', worktree: 'code-conductor_worktree_dcd22e',
    };
    assert.equal(renderInstances([INSTANCE], { inactive: [stopped] }), [
      'INSTANCES (1)',
      '',
      `[1] ${SID_A}`,
      '    status idle   display running   agents 2   queued 0   idle-sub yes',
      '    project code-conductor   worktree code-conductor_worktree_dcd22e',
      '    cwd /w/cc-projects/code-conductor_worktree_dcd22e',
      '    mode code   effort high   thinking adaptive   model claude/claude-opus-5',
      '    playbook classic / implement',
      '    title Recon read tools plain-text rendering',
      '    last 2026-08-06 07:23Z',
      '',
      'INACTIVE (1)',
      '',
      `${SID_B}  2026-08-06 07:23Z  4.2 KB  conducted,temp  code-conductor/code-conductor_worktree_dcd22e  Draft release notes`,
    ].join('\n'));
  });

  test('an inactive row claims no runtime state', () => {
    const out = renderInstances([], { inactive: [{
      sessionId: SID_B, firstPrompt: 'x', title: 'T', conducted: false, temp: false,
      archived: false, mtime: 1, size: 1, project: 'p', worktree: null,
    }] });
    for (const claim of ['status ', 'mode ', 'playbook ', 'display ', 'idle-sub ']) {
      assert.ok(!out.includes(claim), `an inactive row must not render "${claim}" — there is no process to read it from:\n${out}`);
    }
    assert.match(out, /^\S{36}  1970-01-01 00:00Z  1 B  —  p  T$/m, 'a worktree-less row shows the bare project');
  });

  test('inactive rows render in the order given, and every one of them', () => {
    // Ordering is the caller's (newest first by mtime); the renderer must not
    // reorder or drop. Two rows minimum — one row cannot detect either bug.
    const mk = (sid, mtime, title) => ({ sessionId: sid, firstPrompt: null, title,
      conducted: false, temp: false, archived: false, mtime, size: 0, project: 'p', worktree: null });
    const out = renderInstances([], { inactive: [
      mk(SID_A, 1786001000000, 'newest'), mk(SID_B, 1785900000000, 'older'),
    ] });
    assert.match(out, /^INACTIVE \(2\)$/m);
    const lines = out.split('\n').filter(l => l.includes('newest') || l.includes('older'));
    assert.equal(lines.length, 2, 'both rows must render');
    assert.ok(lines[0].includes('newest') && lines[1].includes('older'), `given order must be preserved:\n${out}`);
  });

  test('an all-stopped scope reads as none live, not as a fleet still working', () => {
    const out = renderInstances([], { inactive: [{ sessionId: SID_A, firstPrompt: null,
      title: 'T', conducted: false, temp: false, archived: false, mtime: 1, size: 1,
      project: 'p', worktree: null }] });
    assert.match(out, /^INSTANCES \(none\)$/m);
    assert.match(out, /^INACTIVE \(1\)$/m);
  });

  test('a filter is echoed on the heading, so an empty result is not read as an idle fleet', () => {
    assert.equal(renderInstances([], { project: 'code-conductor' }), 'INSTANCES (none)  project code-conductor');
    assert.match(renderInstances([INSTANCE], { project: 'code-conductor' }), /^INSTANCES \(1\) {2}project code-conductor$/m);
    // Unfiltered stays exactly as it was.
    assert.match(renderInstances([INSTANCE]), /^INSTANCES \(1\)$/m);
  });
});

describe('renderWorktrees', () => {
  test('parent renders once as a header, path under each row', () => {
    assert.equal(renderWorktrees([
      { worktree: 'demo_worktree_ab12', parentProject: 'demo', parentPath: '/w/cc-projects/demo',
        worktreePath: '/w/cc-projects/demo_worktree_ab12', branch: 'demo/ab12',
        baseBranch: 'main', baseSha: 'abc1234', createdAt: '2026-08-01T10:00:00.000Z' },
      { worktree: 'demo_worktree_c9', parentProject: 'demo', parentPath: '/w/cc-projects/demo',
        worktreePath: '/w/cc-projects/demo_worktree_c9', branch: 'demo/c9',
        baseBranch: 'main', baseSha: 'def5678', createdAt: '2026-08-02T11:30:00.000Z' },
    ]), [
      'WORKTREES (2) — demo  /w/cc-projects/demo',
      '',
      'demo_worktree_ab12  br demo/ab12  base main@abc1234  created 2026-08-01 10:00Z',
      '  /w/cc-projects/demo_worktree_ab12',
      'demo_worktree_c9    br demo/c9    base main@def5678  created 2026-08-02 11:30Z',
      '  /w/cc-projects/demo_worktree_c9',
    ].join('\n'));
  });

  test('no worktrees', () => {
    assert.equal(renderWorktrees([]), 'WORKTREES (none)');
  });
});

describe('renderSessions', () => {
  test('full sessionIds, aligned columns, deviating flags only', () => {
    assert.equal(renderSessions([
      { sessionId: SID_A, firstPrompt: 'hi', title: 'Recon rendering', conducted: true,
        temp: true, archived: false, mtime: 1786001000000, size: 4300 },
      { sessionId: SID_B, firstPrompt: 'Draft release notes', title: null, conducted: false,
        temp: false, archived: false, mtime: 1785900000000, size: 120000 },
    ]), [
      'SESSIONS (2)',
      '',
      `${SID_A}  2026-08-06 07:23Z    4.2 KB  conducted,temp  Recon rendering`,
      `${SID_B}  2026-08-05 03:20Z  117.2 KB  —               Draft release notes`,
    ].join('\n'));
  });

  test('firstPrompt stands in for a missing title', () => {
    const out = renderSessions([{ sessionId: SID_B, firstPrompt: 'Draft release notes',
      title: null, conducted: false, temp: false, archived: false, mtime: 0, size: 0 }]);
    assert.match(out, /Draft release notes$/);
  });

  test('archived surfaces when includeArchived brought one back', () => {
    const out = renderSessions([{ sessionId: SID_B, firstPrompt: 'x', title: 'X', conducted: false,
      temp: false, archived: true, mtime: 0, size: 0 }]);
    assert.match(out, /archived/);
  });

  test('no sessions', () => {
    assert.equal(renderSessions([]), 'SESSIONS (none)');
  });
});

describe('renderProjectStatus', () => {
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
      sessions: { count: 1, archivedCount: 0, lastMtime: 1 },
    }]);
    assert.ok(projects.includes('/very/long/absolute/path/to/a/project/root/p'));
    assert.ok(projects.includes(WORKTREE.worktreePath), 'worktree path must not be abbreviated');
    assert.ok(projects.includes(WORKTREE.branch), 'branch name must not be abbreviated');
    assert.ok(renderSessions([{ sessionId: SID_A, firstPrompt: null, title: 't', conducted: false,
      temp: false, archived: false, mtime: 1, size: 1 }]).includes(SID_A));
    assert.ok(renderInstances([INSTANCE]).includes(SID_A));
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
        worktrees: [wt], sessions: { count: 0, archivedCount: 0, lastMtime: 0 } }]),
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

describe('list_instances renders every allowlisted field', () => {
  // A value no renderer could produce on its own, unique per key.
  const sentinel = (k) => `«${k}»`;
  const ALL_KEYS = [...CONDUCTOR_VIEW_KEYS, ...LIST_ONLY_KEYS];

  // Deliberately dropped — see the header comment of src/mcp/readRenderers.ts.
  // Each MUST NOT appear; that is the other half of the binding.
  const DROPPED = ['pid', 'createdAt', 'contextWindowTokens', 'firstPrompt'];
  // Rendered as a fixed label rather than its value, so a sentinel can't be
  // looked for. Checked by its own assertion below instead.
  const LABEL_ONLY = ['hasIdleSubscriber'];
  // Everything else must appear verbatim. A NEW key falls in here by default.
  const BY_VALUE = ALL_KEYS.filter(k => !DROPPED.includes(k) && !LABEL_ONLY.includes(k));

  const sentinelRow = (over = {}) => ({
    ...Object.fromEntries(ALL_KEYS.map(k => [k, sentinel(k)])),
    hasIdleSubscriber: true,
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

  test('every non-exempt allowlisted field reaches the text', () => {
    const out = renderInstances([sentinelRow()]);
    const missing = BY_VALUE.filter(k => !out.includes(sentinel(k)));
    assert.deepEqual(missing, [],
      'these allowlisted fields are never rendered — add them to renderInstances, '
      + `or to DROPPED with a justification in readRenderers.ts:\n${out}`);
  });

  test('every deliberately-dropped field stays out of the text', () => {
    const out = renderInstances([sentinelRow()]);
    const leaked = DROPPED.filter(k => out.includes(sentinel(k)));
    assert.deepEqual(leaked, [], 'a field listed as dropped is being rendered');
  });

  test('hasIdleSubscriber renders as a label, both ways', () => {
    assert.match(renderInstances([sentinelRow({ hasIdleSubscriber: true })]), /idle-sub yes/);
    assert.match(renderInstances([sentinelRow({ hasIdleSubscriber: false })]), /idle-sub no/);
  });

  test('firstPrompt is dropped only because a title is there to replace it', () => {
    // The one conditional exemption: with no title it MUST be rendered, so the
    // fact is never unreachable — it is superseded, not withheld.
    const out = renderInstances([sentinelRow({ title: null })]);
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
// both `spawnable` values, a "*" entry beside allow/deny/require, an empty
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
        spawn_instance: { require: { mode: 'plan', createWorktree: true, label: null } },
        set_mode: 'allow',
      },
      spawnable: true,
      description: STAGE_PROSE,
    },
    fan: {
      needs: [{ stage: 'triage', at: 'current' }, { stage: 'triage', at: 'ever' }],
      workers: 'many',
      tools: {},
      spawnable: false,
    },
    sink: {
      needs: [{ stage: 'fan', at: 'current' }],
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
      '      spawn_instance require {"mode":"plan","createWorktree":true,"label":null}',
      '      set_mode allow',
      '    description',
      '      Brief the worker, then wait for its sentinel before you treat the work as reviewable.',
      '',
      '      tools deny is not a field here — this is authored prose.',
      '▸ fan   workers many   spawnable no',
      '    needs triage@current, triage@ever',
      '    tools (none)',
      '▸ sink   workers one   spawnable no',
      '    needs fan@current',
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
    assert.match(out, /^ {6}spawn_instance require /m);
  });

  test('a require constraint renders every argument name AND value, typed', () => {
    // These are the argument values the gate enforces, so dropping one, or
    // rendering the map as [object Object]/"require", would advertise a call that
    // then refuses ARG_REQUIRE_CONFLICT. JSON spelling keeps "plan" distinct from
    // plan, true from "true", and null from absent.
    assert.match(renderPlaybook(GRAPH),
      /spawn_instance require \{"mode":"plan","createWorktree":true,"label":null\}/);
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
