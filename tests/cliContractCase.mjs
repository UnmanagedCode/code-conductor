// Shared harness for the gated CLI-contract suites
// (tests/systems-cli-*.real.test.mjs). Skipped by default — opt in with
// `RUN_CLI_CONTRACT=1`.
//
// SPLIT ACROSS FILES ON PURPOSE. Every case here is a real `claude` run costing
// 6-26s, so one file was charged their SUM and crossed the hang guard's
// per-file deadline; separate files are charged the MAX (see the reasoning in
// tests/hangGuardConfig.mjs — the answer to a file over the deadline is more
// files, not a later deadline). This module is what keeps the two from drifting
// into two different ideas of how cc launches the CLI.
//
// Redirecting a worker to another system rests entirely on undocumented Claude
// Code behaviour. Nothing in the ordinary suite can notice if a CLI upgrade
// changes any of it, and every failure mode is silent and destructive — which is
// what each case's own header names.
//
// Two rules every case here follows:
//   * Assert over a MECHANICAL channel wherever one exists — a hook envelope,
//     the `system`/`init` frame's tool list, a file on disk — never the model's
//     prose. The model was measured reporting "the background task completed"
//     instead of relaying the path it was asked for.
//   * Every lever gets a CONTROL run without it. A RENAMED key would otherwise
//     leave the with-lever assertion passing for the wrong reason while cc's own
//     scan silently stopped finding the live one.

import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const ENABLED = process.env.RUN_CLI_CONTRACT === '1';
// Every case in every file of this family is registered through this, so the
// gate is stated once.
export const t = ENABLED ? test : test.skip.bind(test);
const MODEL = 'claude-haiku-4-5';
const RUN_TIMEOUT_MS = 180_000;

// A hook endpoint shaped exactly like cc's: one URL, both events, discriminated
// by `hook_event_name`. `reply(envelope)` returns the response body.
export async function hookServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let envelope = {};
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* record it anyway */ }
      seen.push(envelope);
      const body = (await reply(envelope)) ?? {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((r) => server.close(r)),
    of: (event, tool) => seen.filter(e => e.hook_event_name === event && e.tool_name === tool),
  };
}

export function settingsJSON(url, { pre, post = [], deny, extra }) {
  const hooks = [{ type: 'http', url, timeout: 60 }];
  const out = { hooks: { PreToolUse: [{ matcher: pre.join('|'), hooks }] } };
  if (post.length) out.hooks.PostToolUse = [{ matcher: post.join('|'), hooks }];
  if (deny) out.permissions = { deny };
  return JSON.stringify({ ...out, ...extra });
}

export function runClaudeEnv(cwd, settings, prompt, env) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, prompt, ['--output-format', 'json']),
      { cwd, env: { ...process.env, ...env }, timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`unparseable CLI output: ${stdout.slice(0, 500)}`)); }
      });
  });
}

// cc's OWN launch flags, including `--permission-prompt-tool stdio`. The
// headless tool profile depends on them — that flag is what un-strips the
// interactive tools — so a probe run without them is measuring a different
// session than the one cc ships.
export function claudeArgs(settings, prompt, format) {
  return [
    '-p', '--model', MODEL, ...format,
    '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
    '--settings', settings, prompt,
  ];
}

export function runClaude(cwd, settings, prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, prompt, ['--output-format', 'json']),
      { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`unparseable CLI output: ${stdout.slice(0, 500)}`)); }
      });
  });
}

// The `system`/`init` frame's own `tools` list — what the session actually has,
// stated by the CLI rather than inferred from what a model chose to reach for.
export function toolRegistry(cwd, settings) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, 'Reply with the single word OK.', ['--output-format', 'stream-json', '--verbose']),
      { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          let f; try { f = JSON.parse(line); } catch { continue; }
          if (f.type === 'system' && f.subtype === 'init' && Array.isArray(f.tools)) { resolve(f.tools); return; }
        }
        reject(new Error(`no system/init frame with a tool list: ${stdout.slice(0, 500)}`));
      });
  });
}

// A plain command in a directory — the git fixture below is the only user.
export function run(argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export async function fixture() {
  const dir = await fs.realpath(await mkdtemp('cc-cli-contract-'));
  return { dir, clean: () => rmrf(dir) };
}

export const allow = (updatedInput) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'allow',
    ...(updatedInput ? { updatedInput } : {}),
  },
});

