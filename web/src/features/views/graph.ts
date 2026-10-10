// The commit history's branch/merge rail: a git-log --graph style DAG drawn to
// the left of each row. computeGraph assigns each commit a stable column
// ("lane") and snapshots the lanes entering (lanesBefore) and leaving
// (lanesAfter) its row; each row draws its own fixed-height node band plus
// full-height filler lines, so the rail lines up with variable-height rows
// without measuring layout.

export const LANE_W = 14;
export const DOT_R = 3.5;
export const BAND_H = 32;
/** Dot centre, px from the row top: sits on the first text line of a row. */
export const DOT_CY = 17;
/** Soft cap; extra lanes clamp to the last column (logged). */
export const MAX_LANES = 12;

export type Lane = string | null;
export type GraphRow = { sha: string | null; col: number; lanesBefore: Lane[]; lanesAfter: Lane[] };
export type GraphCommit = { sha: string; parents?: string[] };

/**
 * Lane assignment over a newest-first, topo-ordered list (the server passes
 * --topo-order, so no parent precedes its child). A parent ABSENT from the
 * list keeps its lane, which trails off the bottom ("history continues"); a
 * parent already drawn above is never targeted (no phantom lanes).
 */
export function computeGraph(commits: GraphCommit[]): { rows: GraphRow[]; maxCols: number } {
  const active: Lane[] = [];
  const seen = new Set<string>();
  const rows: GraphRow[] = [];
  let maxCols = 0;
  let clamped = false;

  const firstFree = () => {
    for (let k = 0; k < active.length; k++) if (active[k] == null) return k;
    if (active.length >= MAX_LANES) { clamped = true; return MAX_LANES - 1; }
    active.push(null);
    return active.length - 1;
  };

  for (const c of commits) {
    const parents = c.parents ?? [];
    const lanesBefore = active.slice();
    const converging: number[] = [];
    for (let k = 0; k < active.length; k++) if (active[k] === c.sha) converging.push(k);
    const col = converging.length ? Math.min(...converging) : firstFree();
    for (const k of converging) if (k !== col) active[k] = null;
    if (parents.length === 0) {
      active[col] = null;
    } else {
      active[col] = seen.has(parents[0]) ? null : parents[0];
      for (let j = 1; j < parents.length; j++) {
        const p = parents[j];
        if (seen.has(p)) continue;
        if (active.indexOf(p) === -1) active[firstFree()] = p;
      }
    }
    seen.add(c.sha);
    const lanesAfter = active.slice();
    rows.push({ sha: c.sha, col, lanesBefore, lanesAfter });
    maxCols = Math.max(maxCols, lanesBefore.length, lanesAfter.length, col + 1);
  }
  if (clamped) console.warn(`commits graph: lane count exceeded ${MAX_LANES}; extra lanes clamped to the last column`);
  return { rows, maxCols: Math.min(maxCols, MAX_LANES) };
}

/**
 * Whether column k's outgoing segment leaves FROM the dot rather than passing
 * straight through: the first-parent continuation, a freshly opened lane, or a
 * slot that converged into this dot and was reused.
 */
export function laneEmanates(k: number, col: number, lanesBefore: Lane[], sha: string | null) {
  return k === col || lanesBefore[k] == null || lanesBefore[k] === sha;
}

export const laneX = (col: number) => col * LANE_W + LANE_W / 2;

// Categorical identity hues (validated light/dark steps), in fixed order.
const LANE_COLORS_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const LANE_COLORS_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export function laneColor(col: number, dark: boolean) {
  const set = dark ? LANE_COLORS_DARK : LANE_COLORS_LIGHT;
  return set[col % set.length];
}
