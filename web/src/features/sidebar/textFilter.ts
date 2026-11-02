// The Projects lens's text filter, pure: tokenising a query, matching it against
// a node's path, and classifying the project tree into what shows and what the
// filter opens. No React, no DOM.
import { sessionLabel } from '@shared/promptPreview';
import { placeKeyOf, type SessionItem } from './derive';
import type { Project, Worktree } from '@/state/types';

export const tokensOf = (query: string): string[] => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Every token is a substring of some field (case-insensitive); different tokens may hit different fields. */
export function matchesAll(tokens: string[], fields: (string | null | undefined)[]): boolean {
  const hay = fields.map((f) => (f ?? '').toLowerCase());
  return tokens.every((t) => hay.some((f) => f.includes(t)));
}

/** `[start, end)` of every occurrence of every token in `text`, overlapping and adjacent ranges merged, sorted. */
export function highlightRanges(text: string, tokens: string[]): [number, number][] {
  const lower = text.toLowerCase();
  const found: [number, number][] = [];
  for (const t of tokens) {
    for (let at = lower.indexOf(t); at !== -1 && t; at = lower.indexOf(t, at + 1)) found.push([at, at + t.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** A place that shows all its rows, or only the session ids that matched. */
export type NodeHit = { kind: 'whole' } | { kind: 'narrowed'; sessions: Set<string> };
export type ProjectMatch =
  | { kind: 'whole' }
  | { kind: 'narrowed'; main: Set<string> | null; worktrees: Map<string, NodeHit> };
export type TreeMatch = {
  /** Workspaces whose own name matched. */
  workspaces: Set<string>;
  /** Shown projects; absent means hidden. */
  projects: Map<string, ProjectMatch>;
  /** Groups the filter opens: workspace names, projects whose Worktrees group opens, Sessions keys (`placeKeyOf`). */
  forced: { workspaces: Set<string>; worktreeGroups: Set<string>; sessions: Set<string> };
};

export type SearchInput = {
  tokens: string[];
  projects: Project[];
  /** Workspace names, so an empty workspace can still be a name hit. */
  workspaces: string[];
  /** The scope's own predicates (derive.ts). */
  showsProject: (p: Project) => boolean;
  mainShown: (p: Project) => boolean;
  worktreesOf: (p: Project) => Worktree[];
  /** The scope-narrowed, non-archived rows of a place. */
  rowsOf: (project: string, worktree: string | null) => SessionItem[];
};

export const workspaceOf = (p: Project) => (typeof p.workspace === 'string' ? p.workspace.trim() : '');

export function searchTree(input: SearchInput): TreeMatch {
  const { tokens, projects, showsProject, mainShown, worktreesOf, rowsOf } = input;
  const out: TreeMatch = { workspaces: new Set(), projects: new Map(), forced: { workspaces: new Set(), worktreeGroups: new Set(), sessions: new Set() } };
  for (const w of input.workspaces) if (matchesAll(tokens, [w])) out.workspaces.add(w);
  for (const p of projects) {
    const ws = workspaceOf(p);
    if (!showsProject(p)) continue;
    if (ws && out.workspaces.has(ws)) { out.projects.set(p.name, { kind: 'whole' }); continue; }
    if (matchesAll(tokens, [ws, p.name])) {
      out.projects.set(p.name, { kind: 'whole' });
      if (ws) out.forced.workspaces.add(ws);
      continue;
    }
    const worktrees = new Map<string, NodeHit>();
    for (const wt of worktreesOf(p)) {
      const path = [ws, p.name, wt.worktreeName, wt.branch];
      if (matchesAll(tokens, path)) {
        worktrees.set(wt.worktreeName, { kind: 'whole' });
        out.forced.worktreeGroups.add(p.name);
        continue;
      }
      const hits = new Set(rowsOf(p.name, wt.worktreeName).filter((r) => matchesAll(tokens, [...path, sessionLabel(r)])).map((r) => r.sessionId));
      if (hits.size === 0) continue;
      worktrees.set(wt.worktreeName, { kind: 'narrowed', sessions: hits });
      out.forced.worktreeGroups.add(p.name);
      out.forced.sessions.add(placeKeyOf(p.name, wt.worktreeName));
    }
    let main: Set<string> | null = null;
    if (mainShown(p)) {
      const hits = new Set(rowsOf(p.name, null).filter((r) => matchesAll(tokens, [ws, p.name, sessionLabel(r)])).map((r) => r.sessionId));
      if (hits.size > 0) { main = hits; out.forced.sessions.add(p.name); }
    }
    if (!main && worktrees.size === 0) continue;
    out.projects.set(p.name, { kind: 'narrowed', main, worktrees });
    if (ws) out.forced.workspaces.add(ws);
  }
  return out;
}
