// "Opus 200k mode" — the orchestrator-only `[200k]` suffix that strips
// to a bare `claude-opus-4-7` on the wire *and* injects
// CLAUDE_CODE_DISABLE_1M_CONTEXT=1 into the spawn env (the only knob
// the CLI actually honours for downgrading Opus 4.7 to 200k).
//
// Also asserts the [1m] suffix is passed through unchanged (CLI-native).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

async function spawnAndDump(model) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opus200k-'));
  const argvDump = path.join(tmp, 'argv.txt');
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    // Send any prompt so fake-claude emits its startup events + dumps
    // its argv/env synchronously into the files above.
    await ctx.instances.get(id).prompt('hi');
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    const envLines = (await fs.readFile(envDump, 'utf8')).split('\n').filter(Boolean);
    const env = Object.fromEntries(envLines.map(l => {
      const eq = l.indexOf('=');
      return eq < 0 ? [l, ''] : [l.slice(0, eq), l.slice(eq + 1)];
    }));
    return { argv, env, ctx, id };
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    delete process.env.FAKE_CLAUDE_ENV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function modelFromArgv(argv) {
  const i = argv.indexOf('--model');
  return i < 0 ? null : argv[i + 1];
}

test('Opus [200k] strips the suffix on the wire and sets CLAUDE_CODE_DISABLE_1M_CONTEXT=1', async () => {
  const { argv, env, ctx, id } = await spawnAndDump('claude-opus-4-7[200k]');
  try {
    assert.equal(modelFromArgv(argv), 'claude-opus-4-7',
      '--model must be the bare identifier; the CLI does not understand [200k]');
    assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '1',
      'spawn env must set the disable flag — it is the only way to actually get 200k from Opus 4.7');
    // The orchestrator-tracked model retains the synthetic suffix so the
    // UI's contextWindowFor mapping still resolves to 200k.
    assert.equal(ctx.instances.get(id).model, 'claude-opus-4-7[200k]');
  } finally {
    await ctx.close();
  }
});

test('Opus [1m] is passed through unchanged (CLI-native suffix) and does NOT set the disable flag', async () => {
  const { argv, env, ctx, id } = await spawnAndDump('claude-opus-4-7[1m]');
  try {
    assert.equal(modelFromArgv(argv), 'claude-opus-4-7[1m]',
      '--model must keep the [1m] suffix — the CLI parses it via Oh3()');
    assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env),
      'the disable flag must not leak into the env when picking the 1M variant');
    assert.equal(ctx.instances.get(id).model, 'claude-opus-4-7[1m]');
  } finally {
    await ctx.close();
  }
});

test('Bare claude-opus-4-7 (which is 1M by default per CLI) does not set the disable flag', async () => {
  const { env, ctx } = await spawnAndDump('claude-opus-4-7');
  try {
    assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env),
      'bare model name leaves env alone; CLI will use its 1M default');
  } finally {
    await ctx.close();
  }
});

test('Sonnet [1m] is CLI-native and passes through, no env injection', async () => {
  const { argv, env, ctx } = await spawnAndDump('claude-sonnet-4-6[1m]');
  try {
    assert.equal(modelFromArgv(argv), 'claude-sonnet-4-6[1m]');
    assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env));
  } finally {
    await ctx.close();
  }
});
