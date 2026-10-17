// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  filterOptions, filterShows, groupProjects, hasHandSession, mergeLive, revealTarget,
  sessionLabel, sessionSections, sessionsTotal,
} from './derive';
import { deriveConductors } from '@shared/conductors';

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
    inst({ sessionId: 'w1', project: 'api', ownerSessionId: 'cond', conducted: true }),
    inst({ sessionId: 'hand-owner', project: 'api' }),
    inst({ sessionId: 'w2', project: 'api', ownerSessionId: 'hand-owner', conducted: true }),
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

describe('revealTarget', () => {
  const projects = [{ name: 'api', workspace: 'Acme', worktrees: [] }] as any[];
  it('opens the workspace, the worktree group and the place, and the owning conductor', () => {
    const w = inst({ sessionId: 'w', project: 'api', worktree: { worktreeName: 'wt1' }, ownerSessionId: 'cond', conducted: true });
    const conductors = deriveConductors({ conductRows: [], instances: [inst({ sessionId: 'cond', project: '.conduct' }), w] });
    const t = revealTarget({ inst: w, projects, conductors, filter: '' });
    expect(t).toMatchObject({ workspace: 'Acme', worktreesOf: 'api', sessionsKey: 'api:wt1', conductor: 'cond', inactive: false, filter: null });
  });
  it('opens Inactive for a worker of a dead conductor; a selected conductor opens no bubble', () => {
    const c = inst({ sessionId: 'cond', project: '.conduct', status: 'exited' });
    const w = inst({ sessionId: 'w', project: 'api', ownerSessionId: 'cond', conducted: true });
    const conductors = deriveConductors({ conductRows: [], instances: [c, w] });
    expect(revealTarget({ inst: w, projects, conductors, filter: '' })).toMatchObject({ conductor: 'cond', inactive: true });
    expect(revealTarget({ inst: c, projects, conductors, filter: '' })).toMatchObject({ conductor: null, inactive: true, sessionsKey: null });
  });
  it('switches a filter that hides the row: to the owner, Hand-spawned, or All', () => {
    const conductors = { live: [], inactive: [] };
    const owned = inst({ sessionId: 'w', project: 'api', ownerSessionId: 'cond', conducted: true });
    const hand = inst({ sessionId: 'h', project: 'api' });
    const orphan = inst({ sessionId: 'o', project: 'api', conducted: true });
    expect(revealTarget({ inst: owned, projects, conductors, filter: 'hand' }).filter).toBe('cond');
    expect(revealTarget({ inst: hand, projects, conductors, filter: 'cond' }).filter).toBe('hand');
    expect(revealTarget({ inst: orphan, projects, conductors, filter: 'hand' }).filter).toBe('');
    expect(revealTarget({ inst: hand, projects, conductors, filter: 'hand' }).filter).toBe(null);
  });
});
