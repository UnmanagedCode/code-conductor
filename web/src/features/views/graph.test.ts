// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computeGraph, laneEmanates } from './graph';

describe('laneEmanates', () => {
  it('a converged-then-reused lane emanates from the dot', () => {
    expect(laneEmanates(1, 0, ['X', 'S'], 'S')).toBe(true);
  });
  it('an unrelated pass-through lane does not', () => {
    expect(laneEmanates(1, 0, ['S', 'Y'], 'S')).toBe(false);
  });
  it('the first-parent continuation (k === col) does', () => {
    expect(laneEmanates(0, 0, ['S'], 'S')).toBe(true);
  });
  it('a new fork into a free column does', () => {
    expect(laneEmanates(1, 0, ['S', null], 'S')).toBe(true);
  });
});

describe('computeGraph', () => {
  it('topo-ordered merge: both lanes converge at the branch point', () => {
    const { rows, maxCols } = computeGraph([
      { sha: 'M', parents: ['B', 'S2'] },
      { sha: 'B', parents: ['A'] },
      { sha: 'S2', parents: ['S1'] },
      { sha: 'S1', parents: ['A'] },
      { sha: 'A', parents: [] },
    ]);
    expect(maxCols).toBe(2);
    expect(rows[0].lanesAfter).toEqual(['B', 'S2']);
    expect(rows[4].lanesBefore).toEqual(['A', 'A']);
    expect(rows[4].col).toBe(0);
    expect(rows[4].lanesAfter).toEqual([null, null]);
    for (const r of rows) expect(r.col).toBeLessThan(2);
  });

  it('a lane whose parent was already emitted terminates (no phantom lanes)', () => {
    const input = [
      { sha: 'M', parents: ['B', 'S2'] },
      { sha: 'B', parents: ['A'] },
      { sha: 'A', parents: [] },
      { sha: 'S2', parents: ['S1'] },
      { sha: 'S1', parents: ['A'] },
    ];
    const { rows } = computeGraph(input);
    expect(rows[4].lanesAfter).toEqual([null, null]);
    const indexOf = new Map(input.map((c, i) => [c.sha, i]));
    rows.forEach((r, i) => {
      for (const t of r.lanesAfter) if (t != null && indexOf.has(t)) expect(indexOf.get(t)!).toBeGreaterThan(i);
    });
  });

  it('a parent outside the window still trails off the bottom', () => {
    const { rows } = computeGraph([{ sha: 'C2', parents: ['C1'] }, { sha: 'C1', parents: ['C0'] }]);
    expect(rows[1].lanesAfter[0]).toBe('C0');
  });

  it('a merge whose non-first parent was already emitted opens no lane at it', () => {
    const { rows, maxCols } = computeGraph([
      { sha: 'B', parents: [] },
      { sha: 'M', parents: ['A', 'B'] },
      { sha: 'A', parents: [] },
    ]);
    expect(rows[1].lanesAfter).toEqual(['A']);
    expect(maxCols).toBe(1);
    expect(rows[2].lanesAfter).toEqual([null]);
  });

  it('clamps past the lane cap instead of growing without bound', () => {
    const commits = Array.from({ length: 20 }, (_, i) => ({ sha: `t${i}`, parents: [`p${i}`] }));
    expect(computeGraph(commits).maxCols).toBe(12);
  });
});
