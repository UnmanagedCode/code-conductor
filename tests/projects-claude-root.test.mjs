import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { claudeConfigDir, claudeProjectsRoot } from '../src/projects.ts';

// Run a body with an exact env shape for the two overrides, restoring both.
function withEnv({ configDir, projectsRoot }, body) {
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  if (projectsRoot === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
  else process.env.CLAUDE_PROJECTS_ROOT = projectsRoot;
  try {
    body();
  } finally {
    if (prevCfg !== undefined) process.env.CLAUDE_CONFIG_DIR = prevCfg;
    else delete process.env.CLAUDE_CONFIG_DIR;
    if (prevRoot !== undefined) process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
    else delete process.env.CLAUDE_PROJECTS_ROOT;
  }
}

test('claudeProjectsRoot() falls back to ~/.claude/projects without env override', () => {
  withEnv({}, () => {
    assert.equal(claudeProjectsRoot(), path.join(os.homedir(), '.claude', 'projects'));
  });
});

test('claudeConfigDir() falls back to ~/.claude without env override', () => {
  withEnv({}, () => {
    assert.equal(claudeConfigDir(), path.join(os.homedir(), '.claude'));
  });
});

test('claudeConfigDir() honours CLAUDE_CONFIG_DIR', () => {
  withEnv({ configDir: '/opt/cfg' }, () => {
    assert.equal(claudeConfigDir(), '/opt/cfg');
  });
});

// The whole reason claudeProjectsRoot() was re-derived: a host that moved the
// CLI's config dir moved its transcripts with it, and a reader still spelling
// `~/.claude/projects` would be looking where the CLI is not writing.
test('claudeProjectsRoot() follows CLAUDE_CONFIG_DIR', () => {
  withEnv({ configDir: '/opt/cfg' }, () => {
    assert.equal(claudeProjectsRoot(), path.join('/opt/cfg', 'projects'));
  });
});

// CLAUDE_PROJECTS_ROOT stays cc's own reader override and outranks the
// derivation — the fake CLIs in the test suite depend on that precedence.
test('CLAUDE_PROJECTS_ROOT outranks the CLAUDE_CONFIG_DIR derivation', () => {
  withEnv({ configDir: '/opt/cfg', projectsRoot: '/srv/transcripts' }, () => {
    assert.equal(claudeProjectsRoot(), '/srv/transcripts');
  });
});
