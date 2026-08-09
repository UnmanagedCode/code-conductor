// Unit tests for the plan-file tracker's pure parts. planPathFromInput is the
// ONE reader of an ExitPlanMode input's self-declared path (branch 2), shared
// by the live parser and jsonl replay — so its exact skip semantics are a
// contract, not an implementation detail: a field present but not a usable
// string must fall through to the next candidate, not abort the lookup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPathFromInput, planFileFromToolUse } from '../src/planFile.ts';

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
