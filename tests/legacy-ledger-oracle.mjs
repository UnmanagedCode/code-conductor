// A test-only ORACLE for migration 0041: the playbook state the retired
// playbook ledger's fold produced, reimplemented here from that fold's arms
// over the raw old-format file, so the migration's output can be checked to
// fold to the same state. Not a *.test.mjs file; also imported by ad-hoc dry
// runs against a copy of a real store.

import { foldPlaybookState } from '../src/playbookState.ts';

function find(parent, sid) {
  let cur = sid;
  while (parent.get(cur) !== undefined && parent.get(cur) !== cur) cur = parent.get(cur);
  return cur;
}
function union(parent, a, b) {
  if (!parent.has(a)) parent.set(a, a);
  if (!parent.has(b)) parent.set(b, b);
  const ra = find(parent, a); const rb = find(parent, b);
  if (ra !== rb) parent.set(rb, ra);
}

// The old fold: spawn replaces, transition pushes (from === to included),
// enforcement sets `to`, everything else folds nothing.
export function legacyFold(raw) {
  const bySession = new Map(); const enforcement = new Map(); const parent = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string') continue;
    if (ev.kind === 'spawn') {
      const provenance = ev.provenance && typeof ev.provenance === 'object' ? { ...ev.provenance } : {};
      bySession.set(ev.sessionId, {
        sessionId: ev.sessionId, playbook: ev.playbook, stage: ev.stage, stageHistory: [ev.stage], provenance,
        ...(ev.project !== undefined ? { project: ev.project } : {}),
        ...(ev.worktree !== undefined ? { worktree: ev.worktree } : {}),
      });
      if (!parent.has(ev.sessionId)) parent.set(ev.sessionId, ev.sessionId);
      for (const t of Object.values(provenance)) union(parent, t, ev.sessionId);
    } else if (ev.kind === 'transition') {
      const st = bySession.get(ev.sessionId);
      if (!st) continue;
      st.stage = ev.to; st.stageHistory.push(ev.to);
      if (ev.provenance && typeof ev.provenance === 'object') {
        st.provenance = { ...st.provenance, ...ev.provenance };
        for (const t of Object.values(ev.provenance)) union(parent, t, ev.sessionId);
      }
    } else if (ev.kind === 'enforcement') {
      enforcement.set(ev.conductorSessionId, ev.to);
    }
  }
  for (const st of bySession.values()) st.runRoot = find(parent, st.sessionId);
  return { bySession, enforcement };
}

const collapse = (h) => h.filter((s, i) => i === 0 || s !== h[i - 1]);

// The comparable view of a projection: per session its binding, provenance,
// run root and stageHistory (consecutive repeats collapsed on the legacy side,
// where a self-loop pushed one), plus the enforcement map.
export function comparable(p, { collapseHistory }) {
  const sessions = {};
  for (const [sid, st] of [...p.bySession].sort(([a], [b]) => a.localeCompare(b))) {
    sessions[sid] = {
      playbook: st.playbook, stage: st.stage, provenance: st.provenance, runRoot: st.runRoot,
      project: st.project, worktree: st.worktree,
      stageHistory: collapseHistory ? collapse(st.stageHistory) : st.stageHistory,
    };
  }
  return { sessions, enforcement: Object.fromEntries([...p.enforcement].sort(([a], [b]) => a.localeCompare(b))) };
}

// Both sides of the equivalence for one old file and its conversion.
export function equivalenceSides(oldRaw, newRaw) {
  const rows = newRaw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return {
    legacy: comparable(legacyFold(oldRaw), { collapseHistory: true }),
    converted: comparable(foldPlaybookState(rows), { collapseHistory: false }),
  };
}
