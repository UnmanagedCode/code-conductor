// The text filter's pure core: tokens, per-path matching, highlight ranges, and the tree classification.
import { describe, expect, it } from 'vitest';
import { proj, wt } from '@/test/sidebarFleet';
import { filterOwner, scopeShowsMain, scopeShowsProject, scopeWorktrees, type SessionItem } from './derive';
import { highlightRanges, matchesAll, searchTree, tokensOf } from './textFilter';

describe('tokensOf', () => {
  it('splits on whitespace, trims and lowercases; an all-space query has no tokens', () => {
    // Pins: the query's token list is the unit every matcher reads, and blank means "filter inactive".
    expect(tokensOf('  Fix   LOGIN\tbug ')).toEqual(['fix', 'login', 'bug']);
    expect(tokensOf('   ')).toEqual([]);
    expect(tokensOf('')).toEqual([]);
  });
});

describe('matchesAll', () => {
  it('is satisfied by different fields for different tokens, and fails when one token is missing', () => {
    // Pins: AND across tokens with each token free to hit any field of the path.
    expect(matchesAll(['acme', 'login'], ['Acme', 'api', 'fix login'])).toBe(true);
    expect(matchesAll(['acme', 'nope'], ['Acme', 'api', 'fix login'])).toBe(false);
  });
  it('is case-insensitive and ignores null fields', () => {
    expect(matchesAll(['acme'], [null, undefined, 'ACME'])).toBe(true);
    expect(matchesAll(['x'], [null, undefined])).toBe(false);
  });
});

describe('highlightRanges', () => {
  it('marks every occurrence and merges overlapping and adjacent ranges', () => {
    // Pins: ranges are sorted, non-overlapping, and cover repeats of one token.
    expect(highlightRanges('login log login', ['log'])).toEqual([[0, 3], [6, 9], [10, 13]]);
    expect(highlightRanges('abcdef', ['abc', 'bcd'])).toEqual([[0, 4]]);
    expect(highlightRanges('abcdef', ['abc', 'def'])).toEqual([[0, 6]]);
    expect(highlightRanges('ABC', ['b'])).toEqual([[1, 2]]);
    expect(highlightRanges('abc', ['z'])).toEqual([]);
  });
});

const row = (sessionId: string, firstPrompt: string, over: Partial<SessionItem> = {}): SessionItem => ({ sessionId, firstPrompt, lastActivity: 1, ...over });

/** Acme: `shop` (+ worktree `feat-x`, branch cc/feat-x). Ops: `api` (+ worktree `hotfix`). Unassigned: `tools`. */
const projects = [
  proj('shop', { workspace: 'Acme', worktrees: [wt('feat-x')] }),
  proj('api', { workspace: 'Ops', worktrees: [wt('hotfix')] }),
  proj('tools'),
];
const rows: Record<string, SessionItem[]> = {
  shop: [row('s1', 'fix login bug'), row('s2', 'docs pass')],
  'shop:feat-x': [row('s3', 'login page')],
  api: [row('s4', 'rotate keys')],
  'api:hotfix': [row('s5', 'patch tls', { conducted: true, ownerSessionId: 'cond-a' })],
  tools: [row('s6', 'lint sweep', { instanceId: 'i-s6' })],
};

function run(query: string, filter = '') {
  const owners = new Map<string, Set<string>>([['api:hotfix', new Set(['cond-a'])]]);
  const live = new Map<string, any[]>([['tools', [{ conducted: false }]], ['api:hotfix', [{ conducted: true }]]]);
  const byWorktree = live;
  const direct = new Map<string, any[]>([['tools', [{ conducted: false }]]]);
  const owner = filterOwner(filter);
  const scope = { filter, owners, byWorktree };
  return searchTree({
    tokens: tokensOf(query),
    projects,
    workspaces: ['Acme', 'Ops'],
    showsProject: (p) => scopeShowsProject({ project: p, ...scope, direct: direct.get(p.name) ?? [], ownedProjects: new Set(owner ? ['api'] : []) }),
    mainShown: (p) => scopeShowsMain({ project: p, ...scope, direct: direct.get(p.name) ?? [], total: (rows[p.name] ?? []).length }).sessions,
    worktreesOf: (p) => scopeWorktrees({ project: p, worktrees: p.worktrees, ...scope }),
    rowsOf: (project, w) => (rows[w ? `${project}:${w}` : project] ?? []).filter((r) => (owner ? r.ownerSessionId === owner : filter === 'hand' ? !r.conducted : true)),
  });
}

describe('searchTree', () => {
  it('a workspace-name hit shows every member whole and forces nothing', () => {
    const m = run('acme');
    expect([...m.workspaces]).toEqual(['Acme']);
    expect(m.projects.get('shop')).toEqual({ kind: 'whole' });
    expect(m.projects.has('api')).toBe(false);
    expect(m.forced).toEqual({ workspaces: new Set(), worktreeGroups: new Set(), sessions: new Set() });
  });

  it('a project-name hit is whole and forces only its workspace', () => {
    const m = run('api');
    expect(m.projects.get('api')).toEqual({ kind: 'whole' });
    expect(m.forced.workspaces).toEqual(new Set(['Ops']));
    expect(m.forced.worktreeGroups.size).toBe(0);
    expect(m.forced.sessions.size).toBe(0);
  });

  it('a worktree hit through its branch alone is whole and forces the Worktrees group', () => {
    const m = run('cc/feat');
    expect(m.projects.get('shop')).toEqual({ kind: 'narrowed', main: null, worktrees: new Map([['feat-x', { kind: 'whole' }]]) });
    expect(m.forced.worktreeGroups).toEqual(new Set(['shop']));
    expect(m.forced.workspaces).toEqual(new Set(['Acme']));
    expect(m.forced.sessions.size).toBe(0);
  });

  it('a project token plus a session token narrows to exactly the matching sessions and forces their groups', () => {
    const m = run('acme login');
    // `acme` is a workspace hit but `login` is not, so the workspace is not a hit; the path carries both.
    expect(m.workspaces.size).toBe(0);
    expect(m.projects.get('shop')).toEqual({
      kind: 'narrowed',
      main: new Set(['s1']),
      worktrees: new Map([['feat-x', { kind: 'narrowed', sessions: new Set(['s3']) }]]),
    });
    expect(m.forced.workspaces).toEqual(new Set(['Acme']));
    expect(m.forced.worktreeGroups).toEqual(new Set(['shop']));
    expect(m.forced.sessions).toEqual(new Set(['shop', 'shop:feat-x']));
  });

  it('a project with no hit is absent', () => {
    const m = run('login');
    expect([...m.projects.keys()]).toEqual(['shop']);
  });

  it('rows the scope hides never match', () => {
    // `patch` exists only on a conducted row: under Hand it is hidden, under All it matches.
    expect(run('patch', 'hand').projects.size).toBe(0);
    expect(run('patch').projects.has('api')).toBe(true);
    // `lint` is a hand row of an unassigned project.
    expect(run('lint', 'hand').projects.has('tools')).toBe(true);
    // Owner scope shows only the owner's rows: `lint` is nobody's.
    expect(run('lint', 'cond-a').projects.size).toBe(0);
  });

  it('a project the scope hides is never matched, by its own name or through its workspace', () => {
    // `api` has only a conducted worktree session: hidden under Hand, matchable by name or workspace under All.
    expect(run('api', 'hand').projects.has('api')).toBe(false);
    expect(run('ops', 'hand').projects.has('api')).toBe(false);
    expect(run('api').projects.get('api')).toEqual({ kind: 'whole' });
    expect(run('ops').projects.get('api')).toEqual({ kind: 'whole' });
  });
});
