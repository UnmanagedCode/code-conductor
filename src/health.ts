// Startup probe for the `claude` CLI + auth state. Called once during
// server boot so the user sees a loud, actionable warning in the same
// terminal they launched the orchestrator in — sessions would otherwise
// fail silently with the CLI's own auth error appearing only inline in
// the conversation after they try to spawn one.

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeBin } from './claudeLauncher.ts';

const DEFAULT_TIMEOUT_MS = 3000;

export interface ClaudeBinProbe {
  found: boolean;
  command: string;
  version?: string;
  error?: string;
  exitCode?: number | null;
  message?: string;
  stderr?: string;
}

async function probeBin({ timeoutMs }: { timeoutMs: number }): Promise<ClaudeBinProbe> {
  const { command, prefixArgs } = resolveClaudeBin();
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(command, [...prefixArgs, '--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ found: false, command, error: 'spawn', message: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (v: ClaudeBinProbe) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      settle({ found: false, command, error: 'timeout' });
    }, timeoutMs);
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      const code = (err as { code?: unknown }).code === 'ENOENT' ? 'enoent' : 'spawn';
      settle({ found: false, command, error: code, message: err.message });
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        const version = stdout.trim().split(/\s+/)[0] || null;
        settle({ found: true, command, version: version ?? undefined });
      } else {
        settle({ found: false, command, error: 'exit', exitCode: code, stderr: stderr.trim() });
      }
    });
  });
}

async function probeDir(home: string): Promise<{ exists: boolean; path: string }> {
  const p = path.join(home, '.claude');
  try {
    const st = await fsp.stat(p);
    return { exists: st.isDirectory(), path: p };
  } catch {
    return { exists: false, path: p };
  }
}

async function probeAuth(home: string): Promise<{ ok: boolean; source: 'env' | 'credentials' | null }> {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) {
    return { ok: true, source: 'env' };
  }
  const credentials = path.join(home, '.claude', '.credentials.json');
  try {
    await fsp.access(credentials);
    return { ok: true, source: 'credentials' };
  } catch {
    return { ok: false, source: null };
  }
}

export interface ReadinessIssue {
  code: string;
  title: string;
  hint: string;
}

export interface ReadinessResult {
  ok: boolean;
  claudeBin: ClaudeBinProbe;
  claudeDir: { exists: boolean; path: string };
  authenticated: { ok: boolean; source: 'env' | 'credentials' | null };
  issues: ReadinessIssue[];
}

export async function checkClaudeReadiness({ home = os.homedir(), timeoutMs = DEFAULT_TIMEOUT_MS }: { home?: string; timeoutMs?: number } = {}): Promise<ReadinessResult> {
  const [claudeBin, claudeDir, authenticated] = await Promise.all([
    probeBin({ timeoutMs }),
    probeDir(home),
    probeAuth(home),
  ]);
  const issues: ReadinessIssue[] = [];
  if (!claudeBin.found) {
    issues.push({
      code: 'claude_bin_missing',
      title: 'The `claude` CLI is not runnable',
      hint: 'Install Claude Code or set `CLAUDE_BIN` to its path.',
    });
  }
  if (!claudeDir.exists) {
    issues.push({
      code: 'claude_dir_missing',
      title: '`~/.claude/` does not exist',
      hint: 'Run `claude` once in a terminal and complete sign-in to initialize it.',
    });
  }
  if (!authenticated.ok) {
    issues.push({
      code: 'not_authenticated',
      title: 'Claude is not signed in',
      hint: 'Run `claude` in a terminal and complete sign-in, then restart this server. (Or set `ANTHROPIC_API_KEY`.)',
    });
  }
  return {
    ok: issues.length === 0,
    claudeBin,
    claudeDir,
    authenticated,
    issues,
  };
}

export function formatReadiness(result: ReadinessResult): string {
  if (result.ok) {
    const v = result.claudeBin.version ? `v${result.claudeBin.version}` : 'unknown version';
    const src = result.authenticated.source === 'env'
      ? 'ANTHROPIC_API_KEY'
      : 'credentials.json';
    return `claude OK — ${v}, authenticated via ${src}`;
  }
  const bar = '='.repeat(60);
  const lines = [
    bar,
    'WARNING  claude CLI not ready — your sessions will fail until this is fixed',
    bar,
  ];
  for (const issue of result.issues) {
    lines.push(`  [${issue.code}] ${issue.title}`);
    lines.push(`    ${issue.hint}`);
    lines.push('');
  }
  lines.push(bar);
  return lines.join('\n');
}
