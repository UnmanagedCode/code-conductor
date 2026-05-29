import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectsRoot } from '../src/projects.js';

test('claudeProjectsRoot() falls back to ~/.claude/projects without env override', () => {
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  delete process.env.CLAUDE_PROJECTS_ROOT;
  try {
    const r = claudeProjectsRoot();
    assert.equal(r, path.join(os.homedir(), '.claude', 'projects'));
  } finally {
    if (prev !== undefined) process.env.CLAUDE_PROJECTS_ROOT = prev;
  }
});
