// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  filterOptions, filterProjects, filterShows, groupProjects, hasHandSession, mergeLive, revealTarget,
  sessionSections, sessionsTotal,
} from './derive';
import { deriveConductors } from '@shared/conductors';
import { sessionLabel } from '@shared/promptPreview';

const inst = (o: Record<string, any>) => ({ id: o.id ?? `i-${o.sessionId}`, status: 'idle', mode: 'plan', ...o }) as any;

describe('mergeLive', () => {
  it('overlays a live instance onto its disk row and adds a synthetic row for one not on disk yet, newest first', () => {
    const rows = mergeLive(
      [{ sessionId: 'a', lastActivity: 10, title: 'old' }, { sessionId: 'b', lastActivity: 30, temp: true }],
      [inst({ sessionId: 'a', id: 'ia', title: 'renamed', status: 'turn' }), inst({ sessionId: 'c', id: 'ic', createdAt: 20, temp: true })],
    );
    expect(rows.map((r) => r.sessionId)).toEqual(['b', 'c', 'a']);
    expect(rows[2]).toMatchObject({ instanceId: 'ia', instanceStatus: 'turn', title: 'renamed' });
    expect(rows[1]).toMatchObject({ synthetic: true, instanceTemp: true });
    expect(rows[0]).toMatchObject({ instanceTemp: true });
  });

  it('skips an instance with no session yet: it adds no row and overlays none', () => {
    // Invariant: a row exists per sessionId; an instance still spawning (sessionId null) is not one, and does not touch a disk row.
    const rows = mergeLive(
      [{ sessionId: 'a', lastActivity: 10 }],
      [inst({ sessionId: null, id: 'ispawn', status: 'spawning', createdAt: 50 }), inst({ sessionId: 'c', id: 'ic', createdAt: 20 })],
    );
    expect(rows.map((r) => r.sessionId)).toEqual(['c', 'a']);
    expect(rows.some((r) => r.instanceId === 'ispawn')).toBe(false);
    expect(rows[1].instanceId).toBeUndefined();
  });

  it('labels a row by title, then first prompt, then id prefix (or "(new session)" for a fresh live one)', () => {
    expect(sessionLabel({ sessionId: 'abcdef123', title: ' T ', firstPrompt: 'p' })).toBe('T');
    expect(sessionLabel({ sessionId: 'abcdef123', firstPrompt: 'hello   world' })).toBe('hello world');
    expect(sessionLabel({ sessionId: 'abcdef123' })).toBe('abcdef12…');
    expect(sessionLabel({ sessionId: 'abcdef123', synthetic: true })).toBe('(new session)');
  });
});

describe('sessionSections', () => {
  it('orders normal, then temp, then conducted, and drops archived rows', () => {
    const s = sessionSections([
      { sessionId: 'c', conducted: true }, { sessionId: 't', instanceTemp: true }, { sessionId: 'n' }, { sessionId: 'x', archived: true },
    ]);
    expect([s.normal, s.temp, s.conducted].map((l) => l.map((r) => r.sessionId))).toEqual([['n'], ['t'], ['c']]);
  });
});

describe('sessionsTotal / hasHandSession', () => {
  it('adds live sessions the cached disk list does not know yet', () => {
    const cache = new Map([['p', [{ sessionId: 'a' }]]]);
    const live = [inst({ sessionId: 'a' }), inst({ sessionId: 'b' })];
    expect(sessionsTotal({ key: 'p', liveInstances: live, summary: { count: 1 } }, cache)).toBe(2);
    expect(sessionsTotal({ key: 'q', liveInstances: live, summary: { count: 3 } }, cache)).toBe(5);
    expect(sessionsTotal({ key: 'q', liveInstances: [], summary: { count: 0 } }, cache)).toBe(0);
  });
  it('a place has a hand session from its disk handCount or a live non-conducted instance', () => {
    expect(hasHandSession({ liveInstances: [], summary: { handCount: 1 } })).toBe(true);
    expect(hasHandSession({ liveInstances: [inst({ sessionId: 'a', conducted: true })], summary: { handCount: 0 } })).toBe(false);
    expect(hasHandSession({ liveInstances: [inst({ sessionId: 'a' })], summary: null })).toBe(true);
  });
});

describe('groupProjects', () => {
  const projects = [
    { name: 'b', workspace: 'Zed' }, { name: 'a', workspace: 'Acme' }, { name: 'loose', workspace: null },
  ] as any[];
  it('sorts workspaces, keeps empty registered ones, and lists unassigned projects after', () => {
    const { groups, unassigned } = groupProjects({ projects, workspaces: ['Empty'], visible: () => true, filtering: false });
    expect(groups.map((g) => [g.workspace, g.count])).toEqual([['Acme', 1], ['Empty', 0], ['Zed', 1]]);
    expect(unassigned.map((p) => p.name)).toEqual(['loose']);
  });
  it('under a filter drops workspaces with no visible member but keeps their unfiltered count', () => {
    const { groups } = groupProjects({ projects, workspaces: ['Empty'], visible: (p) => p.name === 'a', filtering: true });
    expect(groups.map((g) => [g.workspace, g.members.length, g.count])).toEqual([['Acme', 1, 1]]);
  });
});

describe('filter', () => {
  const instances = [
    inst({ sessionId: 'cond', project: '.conduct', id: 'c1', title: 'Big refactor' }),
    inst({ sessionId: 'w1', project: 'api', rootSessionId: 'cond', conducted: true }),
    inst({ sessionId: 'hand-owner', project: 'api' }),
    inst({ sessionId: 'w2', project: 'api', rootSessionId: 'hand-owner', conducted: true }),
  ];
  const conductors = deriveConductors({ conductRows: [], instances });
  it('offers All, Hand-spawned, each conductor with a chip (by title), then other live owners', () => {
    const opts = filterOptions({ conductors, instances, spawns: {}, registered: new Set(['api']) });
    expect(opts.map((o) => o.value)).toEqual(['', 'hand', 'cond', 'hand-owner']);
    expect(opts[2].label).toBe('Big refactor');
  });
  it('a selected owner shows only its rows; Hand-spawned shows only non-conducted rows', () => {
    expect(filterShows('cond', instances[1])).toBe(true);
    expect(filterShows('cond', instances[3])).toBe(false);
    expect(filterShows('hand', instances[1])).toBe(false);
    expect(filterShows('hand', instances[2])).toBe(true);
    expect(filterShows('', instances[1])).toBe(true);
  });
});

describe('filterProjects', () => {
  it('a conductor filter lists its chip projects and every project it is the root owner of, spawn history or not', () => {
    // Invariant: the filter's project set is the owner's chip projects (direct workers, registered spawn history) unioned with the projects of the live instances whose root owner it is; another owner's and a hand session's projects stay out.
    const instances = [
      inst({ sessionId: 'L', project: '.conduct' }),
      inst({ sessionId: 'SL', project: '.conduct', conducted: true, rootSessionId: 'L' }),
      inst({ sessionId: 'LW', project: 'alpha', conducted: true, rootSessionId: 'L' }),
      inst({ sessionId: 'SW', project: 'beta', conducted: true, rootSessionId: 'L', callerInstanceId: 'i-SL' }),
      inst({ sessionId: 'OW', project: 'other', conducted: true, rootSessionId: 'O' }),
      inst({ sessionId: 'HS', project: 'hand' }),
    ];
    const spawns = { L: [{ project: 'idle', lastSpawnAt: '2026-01-01T00:00:00Z', worktrees: [] }] };
    expect([...filterProjects('L', instances, spawns, new Set(['alpha', 'beta', 'idle']))].sort()).toEqual(['.conduct', 'alpha', 'beta', 'idle']);
    expect([...filterProjects('L', instances, {}, new Set())].sort()).toEqual(['.conduct', 'alpha', 'beta']);
    expect([...filterProjects('SL', instances, {}, new Set())]).toEqual(['beta']);
  });
});

describe('revealTarget', () => {
  const projects = [{ name: 'api', workspace: 'Acme', worktrees: [] }] as any[];
  it('opens the workspace, the worktree group and the place, and the owning conductor', () => {
    const w = inst({ sessionId: 'w', project: 'api', worktree: { worktreeName: 'wt1' }, rootSessionId: 'cond', conducted: true });
    const conductors = deriveConductors({ conductRows: [], instances: [inst({ sessionId: 'cond', project: '.conduct' }), w] });
    const t = revealTarget({ inst: w, instances: [w], projects, conductors, filter: '' });
    expect(t).toMatchObject({ workspace: 'Acme', worktreesOf: 'api', sessionsKey: 'api:wt1', conductor: 'cond', sectionLead: null, inactive: false, filter: null });
  });
  it('opens Inactive for a worker of a dead conductor; a selected conductor opens no bubble', () => {
    const c = inst({ sessionId: 'cond', project: '.conduct', status: 'exited' });
    const w = inst({ sessionId: 'w', project: 'api', rootSessionId: 'cond', conducted: true });
    const instances = [c, w];
    const conductors = deriveConductors({ conductRows: [], instances });
    expect(revealTarget({ inst: w, instances, projects, conductors, filter: '' })).toMatchObject({ conductor: 'cond', inactive: true });
    expect(revealTarget({ inst: c, instances, projects, conductors, filter: '' })).toMatchObject({ conductor: null, inactive: true, sessionsKey: null });
  });
  it('selecting a section lead expands its lead\'s tree; a top-level conductor opens no bubble', () => {
    // Invariant: a conducted .conduct session reveals as a worker of its lead; a non-conducted one is a conductor and reveals nothing.
    const L = inst({ sessionId: 'L', project: '.conduct' });
    const H = inst({ sessionId: 'H', project: '.conduct', conducted: false, rootSessionId: null });
    const SL = inst({ sessionId: 'SL', project: '.conduct', conducted: true, rootSessionId: 'L' });
    const instances = [L, SL, H];
    const conductors = deriveConductors({ conductRows: [], instances });
    expect(revealTarget({ inst: SL, instances, projects, conductors, filter: '' })).toMatchObject({ conductor: 'L', inactive: false, sessionsKey: null, workspace: null, filter: null });
    expect(revealTarget({ inst: L, instances, projects, conductors, filter: '' }).conductor).toBeNull();
    expect(revealTarget({ inst: H, instances, projects, conductors, filter: '' }).conductor).toBeNull();
  });
  it('a section lead\'s worker reveals its section lead as well as its lead', () => {
    // Invariant: a worker whose live direct owner differs from its root owner names that owner as sectionLead; the root stays the conductor, and a worker owned directly by its lead (or the section lead itself) names none.
    const L = inst({ sessionId: 'L', project: '.conduct' });
    const SL = inst({ sessionId: 'SL', project: '.conduct', conducted: true, rootSessionId: 'L' });
    const LW = inst({ sessionId: 'LW', project: 'api', conducted: true, rootSessionId: 'L' });
    const SW = inst({ sessionId: 'SW', project: 'api', conducted: true, rootSessionId: 'L', callerInstanceId: 'i-SL' });
    const instances = [L, SL, LW, SW];
    const conductors = deriveConductors({ conductRows: [], instances });
    expect(revealTarget({ inst: SW, instances, projects, conductors, filter: '' })).toMatchObject({ conductor: 'L', sectionLead: 'SL' });
    expect(revealTarget({ inst: LW, instances, projects, conductors, filter: '' })).toMatchObject({ conductor: 'L', sectionLead: null });
    expect(revealTarget({ inst: SL, instances, projects, conductors, filter: '' })).toMatchObject({ conductor: 'L', sectionLead: null });
  });
  it('switches a filter that hides the row: to the owner, Hand-spawned, or All', () => {
    const conductors = { live: [], inactive: [] };
    const owned = inst({ sessionId: 'w', project: 'api', rootSessionId: 'cond', conducted: true });
    const hand = inst({ sessionId: 'h', project: 'api' });
    const orphan = inst({ sessionId: 'o', project: 'api', conducted: true });
    const instances = [owned, hand, orphan];
    expect(revealTarget({ inst: owned, instances, projects, conductors, filter: 'hand' }).filter).toBe('cond');
    expect(revealTarget({ inst: hand, instances, projects, conductors, filter: 'cond' }).filter).toBe('hand');
    expect(revealTarget({ inst: orphan, instances, projects, conductors, filter: 'hand' }).filter).toBe('');
    expect(revealTarget({ inst: hand, instances, projects, conductors, filter: 'hand' }).filter).toBe(null);
  });
});
