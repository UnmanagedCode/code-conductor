// Plain-text rendering layer for the five MCP recon read tools.
//
// Pure tests — no server boot, no I/O: hand-built payloads in, exact strings
// out, mirroring tests/mcp-recent-turn-bond.test.mjs. The rendering IS the
// contract now (content[0] is the text), so pinning it exactly is the point.
//
// The field-coverage suite at the bottom is the "no field drops" guarantee.
// Wire-level coverage (a live payload's keys are all classified) lives in
// tests/mcp-contract.test.mjs, which has real handler output to check against.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bytes, dash, deviations, heading, indent, table, trunc, ts, block, DASH,
} from '../src/mcp/textRender.ts';
import {
  renderProjects, renderInstances, renderWorktrees, renderSessions, renderProjectStatus,
  PROJECT_HOT, PROJECT_DEVIANT, PROJECT_COLD,
  PROJECT_WORKTREE_HOT, PROJECT_WORKTREE_DEVIANT, PROJECT_WORKTREE_COLD,
  INSTANCE_HOT, INSTANCE_DEVIANT, INSTANCE_COLD,
  WORKTREE_HOT, WORKTREE_DEVIANT, WORKTREE_COLD,
  SESSION_HOT, SESSION_DEVIANT, SESSION_COLD,
  STATUS_HOT, STATUS_DEVIANT, STATUS_COLD,
} from '../src/mcp/readRenderers.ts';
import { CONDUCTOR_VIEW_KEYS } from '../src/mcp/handlers.ts';

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
        sessionIds: [SID_A],
        isGitRepo: true,
        worktrees: [WORKTREE],
        sessions: { count: 11, archivedCount: 1, lastMtime: 1786001000000 },
      },
      {
        name: 'notes',
        path: '/w/cc-projects/notes',
        workspace: 'personal',
        sessionIds: [],
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
      `    ${SID_A}`,
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
      name: 'p', path: '/p', workspace: null, sessionIds: [], isGitRepo: true,
      worktrees: [{ ...WORKTREE, parentProject: 'COLD_PARENT', parentPath: '/COLD_PARENT_PATH' }],
      sessions: { count: 0, archivedCount: 0, lastMtime: 0 },
    }]);
    assert.ok(!out.includes('COLD_PARENT'), 'parentProject/parentPath are structuredContent-only here');
  });

  test('an empty root still names itself', () => {
    assert.equal(renderProjects([]), 'PROJECTS (none)');
  });

  test('an unknown ahead/behind reads as ? rather than a number', () => {
    const out = renderProjects([{
      name: 'p', path: '/p', workspace: null, sessionIds: [], isGitRepo: true,
      worktrees: [{ ...WORKTREE, mergeStatus: { ahead: null, behind: null } }],
      sessions: { count: 0, archivedCount: 0, lastMtime: 0 },
    }]);
    assert.match(out, /ahead \?  behind \?/);
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
    assert.ok(!out.includes('noise'), 'the nested report stays in structuredContent');
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

// ── field coverage: the "no field drops" guarantee ─────────────────────────

describe('field coverage', () => {
  const keysOf = (hot, deviant, cold) => [...hot, ...deviant.map(d => d.key), ...cold];

  function assertPartition(label, hot, deviant, cold, expected) {
    const all = keysOf(hot, deviant, cold);
    assert.ok(all.length > 0, `${label}: vacuous — no keys classified`);
    assert.equal(new Set(all).size, all.length, `${label}: a key is classified twice`);
    assert.deepEqual(new Set(all), new Set(expected),
      `${label}: HOT ∪ DEVIANT ∪ COLD must exactly cover the payload keys.\n`
      + `  unclassified: ${expected.filter(k => !all.includes(k)).join(', ') || '(none)'}\n`
      + `  not in payload: ${all.filter(k => !expected.includes(k)).join(', ') || '(none)'}`);
  }

  // list_instances is the one whose key set is owned by code rather than by
  // this test: CONDUCTOR_VIEW_KEYS plus the three fields listInstances alone
  // re-attaches (src/mcp/handlers.ts). Adding a key there fails this test until
  // it is classified — the same pinning discipline as mcp-conductor-view.
  test('list_instances covers CONDUCTOR_VIEW_KEYS plus the three list-only fields', () => {
    assert.ok(CONDUCTOR_VIEW_KEYS.length > 20, 'vacuity guard: allowlist looks empty');
    assertPartition('list_instances', INSTANCE_HOT, INSTANCE_DEVIANT, INSTANCE_COLD,
      [...CONDUCTOR_VIEW_KEYS, 'hasIdleSubscriber', 'playbook', 'stage']);
  });

  test('list_projects', () => {
    assertPartition('list_projects', PROJECT_HOT, PROJECT_DEVIANT, PROJECT_COLD,
      ['name', 'path', 'workspace', 'sessionIds', 'isGitRepo', 'worktrees', 'sessions']);
  });

  test('list_projects → nested worktree entry', () => {
    assertPartition('list_projects.worktrees[]', PROJECT_WORKTREE_HOT, PROJECT_WORKTREE_DEVIANT,
      PROJECT_WORKTREE_COLD, Object.keys(WORKTREE));
  });

  test('list_worktrees', () => {
    assertPartition('list_worktrees', WORKTREE_HOT, WORKTREE_DEVIANT, WORKTREE_COLD,
      ['worktree', 'parentProject', 'parentPath', 'worktreePath', 'branch', 'baseBranch',
        'baseSha', 'createdAt']);
  });

  test('list_sessions', () => {
    assertPartition('list_sessions', SESSION_HOT, SESSION_DEVIANT, SESSION_COLD,
      ['sessionId', 'firstPrompt', 'title', 'conducted', 'temp', 'archived', 'mtime', 'size']);
  });

  test('project_status', () => {
    assertPartition('project_status', STATUS_HOT, STATUS_DEVIANT, STATUS_COLD,
      ['project', 'worktree', 'cwd', 'files', 'isGitRepo', 'branch', 'head', 'dirty',
        'dirtyTotal', 'dirtyTruncated', 'recentCommits', 'baseBranch', 'baseSha',
        'mergeStatus', 'diffStat']);
  });

  test('handles survive at full length — they are meant to be copied back', () => {
    const projects = renderProjects([{
      name: 'p', path: '/very/long/absolute/path/to/a/project/root/p', workspace: null,
      sessionIds: [SID_A], isGitRepo: true, worktrees: [WORKTREE],
      sessions: { count: 1, archivedCount: 0, lastMtime: 1 },
    }]);
    assert.ok(projects.includes(SID_A), 'sessionId must not be abbreviated');
    assert.ok(projects.includes('/very/long/absolute/path/to/a/project/root/p'));
    assert.ok(projects.includes(WORKTREE.worktreePath), 'worktree path must not be abbreviated');
    assert.ok(renderSessions([{ sessionId: SID_A, firstPrompt: null, title: 't', conducted: false,
      temp: false, archived: false, mtime: 1, size: 1 }]).includes(SID_A));
    assert.ok(renderInstances([INSTANCE]).includes(SID_A));
  });
});
