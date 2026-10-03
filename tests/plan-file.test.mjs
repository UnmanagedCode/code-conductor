// Unit tests for the plan-file tracker's pure parts. planPathFromInput is the
// ONE reader of an ExitPlanMode input's self-declared path (branch 2), shared
// by the live parser and jsonl replay — so its exact skip semantics are a
// contract, not an implementation detail: a field present but not a usable
// string must fall through to the next candidate, not abort the lookup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planPathFromInput, planFileFromToolUse, PlanFileTracker } from '../src/planFile.ts';

test('planPathFromInput prefers planFilePath, falls back to planPath', () => {
  assert.equal(planPathFromInput({ planFilePath: '/a.md' }), '/a.md');
  assert.equal(planPathFromInput({ planPath: '/b.md' }), '/b.md');
  assert.equal(planPathFromInput({ planFilePath: '/a.md', planPath: '/b.md' }), '/a.md');
});

test('planPathFromInput falls THROUGH a present-but-unusable planFilePath', () => {
  // Empty string and non-strings are not paths. `??` would stop at them and
  // return null, silently dropping a perfectly good planPath beside them.
  assert.equal(planPathFromInput({ planFilePath: '', planPath: '/b.md' }), '/b.md');
  assert.equal(planPathFromInput({ planFilePath: 123, planPath: '/b.md' }), '/b.md');
  assert.equal(planPathFromInput({ planFilePath: false, planPath: '/b.md' }), '/b.md');
});

test('planPathFromInput yields null when nothing usable is named', () => {
  assert.equal(planPathFromInput({}), null);
  assert.equal(planPathFromInput(null), null);
  assert.equal(planPathFromInput(undefined), null);
  assert.equal(planPathFromInput({ planFilePath: '', planPath: '' }), null);
  assert.equal(planPathFromInput({ plan: 'Step 1' }), null);
});

test('planFileFromToolUse recognises only a Write under ~/.claude/plans/*.md', () => {
  assert.equal(planFileFromToolUse('Write', { file_path: '/home/u/.claude/plans/p.md' }), '/home/u/.claude/plans/p.md');
  assert.equal(planFileFromToolUse('Edit', { file_path: '/home/u/.claude/plans/p.md' }), null);
  assert.equal(planFileFromToolUse('Write', { file_path: '/home/u/.claude/plans/p.txt' }), null);
  assert.equal(planFileFromToolUse('Write', { file_path: '/home/u/notes/p.md' }), null);
  assert.equal(planFileFromToolUse('Write', { file_path: 42 }), null);
  assert.equal(planFileFromToolUse('Write', null), null);
});

// A real file, so branch 3's readFileSync is observable on the enriched event.
function tmpPlan(content) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'planseed-'));
  const file = path.join(dir, 'p.md');
  writeFileSync(file, content);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const emptyPlanRequest = () => ({ kind: 'plan_request', plan: null, planPath: null });

test('seed into an empty tracker binds an empty-input plan_request (branch 3): planPath + file contents', () => {
  const a = tmpPlan('# seeded\n');
  try {
    const t = new PlanFileTracker();
    t.seed(a.file);
    const ev = emptyPlanRequest();
    t.enrich(ev);
    assert.equal(ev.planPath, a.file);
    assert.equal(ev.plan, '# seeded\n');
  } finally { a.cleanup(); }
});

test('seed never overrides a live Write latched before it', () => {
  const b = tmpPlan('B\n');
  try {
    const t = new PlanFileTracker();
    t.noteToolUse('Write', { file_path: '/home/u/.claude/plans/live.md' });
    t.seed(b.file);
    assert.equal(t.lastPath, '/home/u/.claude/plans/live.md');
  } finally { b.cleanup(); }
});

test('a seeded path does not bind an inline plan (branch 1)', () => {
  const a = tmpPlan('A\n');
  try {
    const t = new PlanFileTracker();
    t.seed(a.file);
    const ev = { kind: 'plan_request', plan: 'x', planPath: null };
    t.enrich(ev);
    assert.equal(ev.planPath, null);
    assert.equal(ev.plan, 'x');
  } finally { a.cleanup(); }
});

test('planFileFromToolUse accepts a Windows or mixed-separator plans path unchanged', () => {
  const win = 'C:\\Users\\u\\.claude\\plans\\p.md';
  const mixed = 'C:/Users/u/.claude\\plans\\p.md';
  assert.equal(planFileFromToolUse('Write', { file_path: win }), win);
  assert.equal(planFileFromToolUse('Write', { file_path: mixed }), mixed);
  assert.equal(planFileFromToolUse('Write', { file_path: 'C:\\Users\\u\\notes\\p.md' }), null);
  assert.equal(planFileFromToolUse('Write', { file_path: 'C:\\Users\\u\\.claude\\plans\\p.txt' }), null);
  assert.equal(planFileFromToolUse('Edit', { file_path: win }), null);
});

test('a Windows-style Write latches, then an empty-input plan_request gets planPath (branch 3)', () => {
  const win = 'C:\\Users\\u\\.claude\\plans\\absent.md';
  const t = new PlanFileTracker();
  t.noteToolUse('Write', { file_path: win });
  const ev = emptyPlanRequest();
  t.enrich(ev);
  assert.equal(ev.planPath, win);
});
