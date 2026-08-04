// Context-window policy. Every model has exactly ONE native capacity:
//   - the `claude` catalog declares it per version (src/modelVersions.ts), plus
//     an optional `launchTag` for builds that need a suffix to reach it —
//     Sonnet 4.x ships separate 200k/1M builds so it always launches `[1m]`;
//     Sonnet 5 / Opus / Fable are natively 1M and launch bare; Haiku is 200k.
//   - a substitution backend's model declares it on its custom-model row.
// The number is resolved ONCE server-side from {backend, exact model} and
// surfaces as `contextWindowTokens`.
//
// The load-bearing invariant here is that canonicalization is gated on
// `backend`, never on what the model id looks like: a substitution model id is
// an opaque registry key that may legitimately end in `[1m]`. Truncating it
// desynchronises the key and silently drops the context env vars.
//
// The orchestrator never injects CLAUDE_CODE_DISABLE_1M_CONTEXT — that env flag
// must never appear.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { Instance } from '../src/instances.js';
import { canonicalizeModel, familyOf, claudeContextWindowTokens, CLAUDE_BACKEND_ID } from '../src/modelVersions.ts';
import { addCustomModel, removeCustomModel, addBackend, resolveContextWindowTokens } from '../src/appSettings.js';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

// One server shared across the file; each test gets a fresh PROJECTS_ROOT and
// the spawned instance is cleared between tests. See helpers → freshProjectsRoot.
let ctx, baseUrl, instances, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

async function spawnAndDump(model, { backend, project = 'p' } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const argvDump = path.join(tmp, 'argv.txt');
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: project });
    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', model, backend });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    // fake-claude writes its argv/env dumps synchronously at process start
    // (fake-claude.mjs:42-53), before reading any stdin — so no prompt is
    // needed, just wait for the dump file to land.
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    const envLines = (await fs.readFile(envDump, 'utf8')).split('\n').filter(Boolean);
    const env = Object.fromEntries(envLines.map(l => {
      const eq = l.indexOf('=');
      return eq < 0 ? [l, ''] : [l.slice(0, eq), l.slice(eq + 1)];
    }));
    return { argv, env, id, summary: r.body };
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

test('familyOf infers the family by prefix, bare or suffixed', () => {
  assert.equal(familyOf('claude-fable-5'), 'fable');
  assert.equal(familyOf('claude-opus-4-8'), 'opus');
  assert.equal(familyOf('claude-opus-4-8[200k]'), 'opus');
  assert.equal(familyOf('claude-sonnet-4-6'), 'sonnet');
  assert.equal(familyOf('claude-haiku-4-5'), 'haiku');
  assert.equal(familyOf('gpt-4'), null);
  assert.equal(familyOf(null), null);
});

test('canonicalizeModel applies each Claude version\'s catalog launch tag', () => {
  const C = CLAUDE_BACKEND_ID;
  // Natively-1M models launch BARE — no tag exists or is needed.
  assert.equal(canonicalizeModel('claude-fable-5', C), 'claude-fable-5');
  assert.equal(canonicalizeModel('claude-opus-4-8', C), 'claude-opus-4-8');
  assert.equal(canonicalizeModel('claude-sonnet-5', C), 'claude-sonnet-5');
  // Sonnet 4.x ships separate builds — its 1M capacity needs the tag. Idempotent.
  assert.equal(canonicalizeModel('claude-sonnet-4-6', C), 'claude-sonnet-4-6[1m]');
  assert.equal(canonicalizeModel('claude-sonnet-4-6[1m]', C), 'claude-sonnet-4-6[1m]');
  assert.equal(canonicalizeModel('claude-sonnet-4-5', C), 'claude-sonnet-4-5[1m]');
  // A stale tag on a model that has none is dropped.
  assert.equal(canonicalizeModel('claude-opus-4-8[200k]', C), 'claude-opus-4-8');
  assert.equal(canonicalizeModel('claude-sonnet-5[1m]', C), 'claude-sonnet-5');
  // Haiku → 200k (bare).
  assert.equal(canonicalizeModel('claude-haiku-4-5', C), 'claude-haiku-4-5');
  // Unlisted claude-* ids and empties pass through.
  assert.equal(canonicalizeModel('claude-future-9', C), 'claude-future-9');
  assert.equal(canonicalizeModel('', C), '');
  assert.equal(canonicalizeModel(null, C), null);
});

test('canonicalizeModel is verbatim for ANY non-claude backend, including Claude-shaped ids', () => {
  // THE regression. A substitution model id is an opaque registry key. The old
  // implementation stripped a terminal [1m]/[200k] BEFORE asking whether the id
  // was Claude, so `gpt-5.6-sol[1m]` became `gpt-5.6-sol` and stopped matching
  // its own registry row.
  assert.equal(canonicalizeModel('gpt-5.6-sol[1m]', 'codex'), 'gpt-5.6-sol[1m]');
  assert.equal(canonicalizeModel('weird[200k]', 'my-proxy'), 'weird[200k]');
  assert.equal(canonicalizeModel('deepseek-v4-flash:cloud', 'ollama'), 'deepseek-v4-flash:cloud');
  // …and the gate is the BACKEND, not the name: an id that looks exactly like a
  // Claude model is still opaque when a substitution backend serves it.
  assert.equal(canonicalizeModel('claude-sonnet-4-6', 'my-proxy'), 'claude-sonnet-4-6');
  assert.equal(canonicalizeModel('claude-sonnet-4-6[1m]', 'my-proxy'), 'claude-sonnet-4-6[1m]');
  // A missing backend argument fails toward PRESERVING the caller's id.
  assert.equal(canonicalizeModel('gpt-5.6-sol[1m]'), 'gpt-5.6-sol[1m]');
});

test('claudeContextWindowTokens reports one capacity per version, null when unknown', () => {
  assert.equal(claudeContextWindowTokens('claude-haiku-4-5'), 200_000);
  assert.equal(claudeContextWindowTokens('claude-sonnet-5'), 1_000_000);
  assert.equal(claudeContextWindowTokens('claude-opus-4-8'), 1_000_000);
  assert.equal(claudeContextWindowTokens('claude-fable-5'), 1_000_000);
  // Tolerates the launch tag on the way in.
  assert.equal(claudeContextWindowTokens('claude-sonnet-4-6[1m]'), 1_000_000);
  assert.equal(claudeContextWindowTokens('claude-sonnet-4-6'), 1_000_000);
  // Unknown stays unknown — never a fabricated 200k.
  assert.equal(claudeContextWindowTokens('claude-future-9'), null);
  assert.equal(claudeContextWindowTokens('gpt-5.6-sol[1m]'), null);
  assert.equal(claudeContextWindowTokens(null), null);
});

test('resolveContextWindowTokens dispatches on backend and needs the EXACT substitution id', async () => {
  await addBackend({ id: 'codex', label: 'Codex', template: 'codexctl run claude --model {model} --', env: [] });
  await addCustomModel({ label: 'Sol', model: 'gpt-5.6-sol[1m]', backend: 'codex', contextWindow: 1_000_000 });
  try {
    assert.equal(resolveContextWindowTokens({ backend: CLAUDE_BACKEND_ID, model: 'claude-haiku-4-5' }), 200_000);
    // The tagged id IS the key; the truncated form is a different, unknown model.
    assert.equal(resolveContextWindowTokens({ backend: 'codex', model: 'gpt-5.6-sol[1m]' }), 1_000_000);
    assert.equal(resolveContextWindowTokens({ backend: 'codex', model: 'gpt-5.6-sol' }), null);
    assert.equal(resolveContextWindowTokens({ backend: 'codex', model: null }), null);
  } finally {
    await removeCustomModel('gpt-5.6-sol[1m]');
  }
});

test('Opus spawns bare (1M) with no disable flag', async () => {
  const { argv, env, id } = await spawnAndDump('claude-opus-4-8');
  assert.equal(modelFromArgv(argv), 'claude-opus-4-8');
  assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env),
    'the disable flag must never be set — Opus runs at its 1M default');
  assert.equal(instances.get(id).model, 'claude-opus-4-8');
});

test('Sonnet is canonicalised to the CLI-native [1m] suffix (1M), no disable flag', async () => {
  const { argv, env, id } = await spawnAndDump('claude-sonnet-4-6');
  assert.equal(modelFromArgv(argv), 'claude-sonnet-4-6[1m]',
    'Sonnet needs the [1m] suffix to get a 1M window');
  assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env));
  assert.equal(instances.get(id).model, 'claude-sonnet-4-6[1m]');
});

test('Haiku spawns bare (200k), no disable flag', async () => {
  const { argv, env, id } = await spawnAndDump('claude-haiku-4-5');
  assert.equal(modelFromArgv(argv), 'claude-haiku-4-5');
  assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env));
  assert.equal(instances.get(id).model, 'claude-haiku-4-5');
});

test('a stale [200k] suffix is normalised away — Opus no longer downgrades to 200k', async () => {
  const { argv, env, id } = await spawnAndDump('claude-opus-4-8[200k]');
  assert.equal(modelFromArgv(argv), 'claude-opus-4-8',
    'the [200k] suffix is dropped; Opus runs at 1M');
  assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env),
    'we no longer inject the disable flag');
  assert.equal(instances.get(id).model, 'claude-opus-4-8');
});

// ── the tagged-substitution-model regression ─────────────────────────────
// A custom model whose exact registry key ENDS IN `[1m]`. Everything downstream
// keys off that byte-exact string, so any normalization breaks the chain.
// Deliberately on a USER-DEFINED backend id (not `ollama`): narrowing any of the
// substitution guards to `=== 'ollama'` must fail these.
async function withTaggedCodexModel(fn) {
  await addBackend({ id: 'codex', label: 'Codex', template: 'codexctl run claude --model {model} --', env: [] });
  await addCustomModel({ label: 'Sol', model: 'gpt-5.6-sol[1m]', backend: 'codex', contextWindow: 1_000_000 });
  try { await fn(); } finally { await removeCustomModel('gpt-5.6-sol[1m]').catch(() => {}); }
}

test('a tagged non-Claude model reaches BOTH argv slots byte-exact', async () => {
  await withTaggedCodexModel(async () => {
    const { argv, id, summary } = await spawnAndDump('gpt-5.6-sol[1m]', { backend: 'codex', project: 'codex-a' });
    // The template's {model} slot…
    assert.deepEqual(argv.slice(0, 4), ['run', 'claude', '--model', 'gpt-5.6-sol[1m]']);
    // …and the uniform forwarded --model. Both carry the tag, neither is stripped.
    const slots = argv.map((a, i) => a === '--model' ? argv[i + 1] : null).filter(Boolean);
    assert.equal(slots.length, 2);
    for (const m of slots) assert.equal(m, 'gpt-5.6-sol[1m]');
    // The registry key survives on the instance and in the summary.
    assert.equal(instances.get(id).model, 'gpt-5.6-sol[1m]');
    assert.equal(summary.model, 'gpt-5.6-sol[1m]');
  });
});

test('a tagged non-Claude model resolves its context env from the exact registry key', async () => {
  await withTaggedCodexModel(async () => {
    // Poison the ambient env so a pass can't come from inherited values.
    const saved = {
      c: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      m: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      hadC: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' in process.env,
      hadM: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS' in process.env,
    };
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '999999';
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '999999';
    try {
      const { env, summary } = await spawnAndDump('gpt-5.6-sol[1m]', { backend: 'codex', project: 'codex-b' });
      // Stripping the tag would miss the registry row and leave BOTH unset — the
      // exact bug that let a session run uncapped while the UI showed 200k.
      assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
      assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
      assert.equal(summary.contextWindowTokens, 1_000_000);
    } finally {
      if (saved.hadC) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = saved.c;
      else delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      if (saved.hadM) process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = saved.m;
      else delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    }
  });
});

test('_trackModel never adopts ANY report on a substitution backend, lossy or not', async () => {
  await withTaggedCodexModel(async () => {
    const { id } = await spawnAndDump('gpt-5.6-sol[1m]', { backend: 'codex', project: 'codex-c' });
    const inst = instances.get(id);
    const events = [];
    inst.on('event', (e) => { if (e.subtype === 'model_changed') events.push(e); });

    // Every shape the inner CLI can report. Suppression is UNCONDITIONAL for a
    // substitution backend with a configured model, so all of these are ignored:
    const reports = [
      // 1. the build tag dropped — what a real substitution backend emits
      'gpt-5.6-sol',
      // 2. and again, to prove idempotence rather than a one-shot latch
      'gpt-5.6-sol',
      // 3. a `:tag`-and-build-tag combination
      'gpt-5.6-sol:cloud',
      // 4. THE REGRESSION: a report that is NOT a lossy rendering of the
      //    configured id at all. Matching only lossy shapes let this through, so
      //    the foreign id replaced the registry key — and `spawn()` then wrote it,
      //    with the wrong capacity, into session-backends.json, which this design
      //    makes the authority for both. Reproduced in the suite via
      //    scenario-basic.json, whose system/init hardcodes a Claude id.
      'claude-sonnet-4-6',
      // 5. an unrelated id with no shared prefix
      'some-other-model',
    ];
    for (const r of reports) inst._trackModel(r);

    assert.equal(inst.model, 'gpt-5.6-sol[1m]', 'the configured registry key is authoritative');
    assert.equal(inst.contextWindowTokens, 1_000_000, 'capacity must not follow a foreign report');
    assert.deepEqual(events, [], 'a substitution backend never reports a live switch');
  });
});

test('a substitution-backend spawn sets CLAUDE_CODE_AUTO_COMPACT_WINDOW to the curated model window (raw tokens, no ×1000)', async () => {
  const { env, id } = await spawnAndDump('deepseek-v4-flash:cloud', { backend: 'ollama', project: 'ollama-a' });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000',
    'a 1M curated model sets the raw token count directly');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000',
    'MAX_CONTEXT_TOKENS must also be set — AUTO_COMPACT_WINDOW alone is clamped by the CLI to a 200k assumed window for unrecognized models');
  assert.equal(instances.get(id).backend, 'ollama');
});

test('a substitution-backend spawn honours a smaller curated window (256k)', async () => {
  const { env } = await spawnAndDump('qwen3.5:cloud', { backend: 'ollama', project: 'ollama-b' });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '256000');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '256000');
});

test('a substitution-backend spawn uses a custom model\'s declared contextWindow', async () => {
  await addCustomModel({ label: 'Local Big', model: 'localbig:cloud', backend: 'ollama', contextWindow: 300_000 });
  const { env } = await spawnAndDump('localbig:cloud', { backend: 'ollama', project: 'ollama-c' });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '300000');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '300000');
});

// A BOUND custom model always carries a window now (contextWindow is required),
// so the "window unknown" spawn path is reached via a model that has since been
// REMOVED from the custom list — e.g. a resume of a session whose model was
// deleted. contextWindowForModel returns null and we must set neither var.
test('a substitution-backend spawn whose model has no resolvable window leaves CLAUDE_CODE_AUTO_COMPACT_WINDOW and CLAUDE_CODE_MAX_CONTEXT_TOKENS unset', async () => {
  await addCustomModel({ label: 'Local NoWin', model: 'localnowin:cloud', backend: 'ollama', contextWindow: 128_000 });
  await removeCustomModel('localnowin:cloud'); // window no longer resolvable
  const hadAmbientCompact = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' in process.env;
  const savedAmbientCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const hadAmbientMax = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS' in process.env;
  const savedAmbientMax = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '999999'; // poison: prove the strip, not ambient luck
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '999999';
  try {
    const { env } = await spawnAndDump('localnowin:cloud', { backend: 'ollama', project: 'ollama-d' });
    assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env),
      'no declared window → the CLI uses its own default, we set nothing (even with an ambient value present)');
    assert.ok(!('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in env),
      'no declared window → we set nothing (even with an ambient value present)');
  } finally {
    if (hadAmbientCompact) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = savedAmbientCompact;
    else delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    if (hadAmbientMax) process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = savedAmbientMax;
    else delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  }
});

test('a Claude-backed spawn never sets CLAUDE_CODE_AUTO_COMPACT_WINDOW or CLAUDE_CODE_MAX_CONTEXT_TOKENS', async () => {
  const hadAmbientCompact = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' in process.env;
  const savedAmbientCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const hadAmbientMax = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS' in process.env;
  const savedAmbientMax = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '999999'; // poison: prove the strip, not ambient luck
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '999999';
  try {
    const { env } = await spawnAndDump('claude-opus-4-8', { project: 'claude-x' });
    assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env));
    assert.ok(!('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in env));
  } finally {
    if (hadAmbientCompact) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = savedAmbientCompact;
    else delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    if (hadAmbientMax) process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = savedAmbientMax;
    else delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  }
});

test('each Claude model spawns at its ONE native window: Sonnet 5 bare, Sonnet 4.6 tagged, Haiku 200k', async () => {
  // Sonnet 5 is natively 1M — bare, no tag. (It used to be pinned `[1m]`.)
  const s5 = await spawnAndDump('claude-sonnet-5', { project: 'nat-a' });
  assert.equal(modelFromArgv(s5.argv), 'claude-sonnet-5');
  assert.equal(s5.summary.contextWindowTokens, 1_000_000);
  assert.equal(instances.get(s5.id).model, 'claude-sonnet-5');

  // Sonnet 4.6 reaches its 1M capacity only via the tag.
  const s46 = await spawnAndDump('claude-sonnet-4-6', { project: 'nat-b' });
  assert.equal(modelFromArgv(s46.argv), 'claude-sonnet-4-6[1m]');
  assert.equal(s46.summary.contextWindowTokens, 1_000_000);

  // Haiku is 200k, bare — the one Claude model that is not 1M.
  const h = await spawnAndDump('claude-haiku-4-5', { project: 'nat-c' });
  assert.equal(modelFromArgv(h.argv), 'claude-haiku-4-5');
  assert.equal(h.summary.contextWindowTokens, 200_000);
});

test('an unlisted claude-* id reports UNKNOWN capacity rather than a fabricated default', async () => {
  const { summary } = await spawnAndDump('claude-future-9', { project: 'nat-d' });
  assert.equal(summary.model, 'claude-future-9');
  assert.equal(summary.contextWindowTokens, null,
    'unknown must stay unknown — a 200k guess reads as a measured cap in the UI');
});


// ── the removed field must be gone from REST too ─────────────────────────
test('REST instance summaries carry contextWindowTokens and no sonnetWindow', async () => {
  const { summary, id } = await spawnAndDump('claude-haiku-4-5', { project: 'rest-a' });

  // POST response…
  assert.ok(!('sonnetWindow' in summary), 'the create response must not carry sonnetWindow');
  assert.equal(summary.contextWindowTokens, 200_000);

  // …and the list endpoint.
  const listed = await api(baseUrl, 'GET', '/api/instances');
  const row = listed.body.find(i => i.id === id);
  assert.ok(row, 'the spawned instance must be listed');
  assert.ok(!('sonnetWindow' in row));
  assert.equal(row.contextWindowTokens, 200_000);
  assert.equal(typeof row.contextWindowTokens, 'number');
});


// ── F3: the env block reads the STORED number, not a live re-resolve ──────
// The only behavioural difference between reading `this.contextWindowTokens` and
// re-resolving at spawn time is what happens when the registry can no longer
// answer. Deleting the row BEFORE create makes both forms agree (carried is null
// too), so the row must be deleted AFTER the number is resolved.
test('a respawn after the custom-model row is DELETED still injects the resolved window', async () => {
  await addBackend({ id: 'codex', label: 'Codex', template: 'codexctl run claude --model {model} --', env: [] });
  await addCustomModel({ label: 'Sol', model: 'gpt-5.6-sol[1m]', backend: 'codex', contextWindow: 1_000_000 });

  const { id, summary } = await spawnAndDump('gpt-5.6-sol[1m]', { backend: 'codex', project: 'codex-del' });
  assert.equal(summary.contextWindowTokens, 1_000_000);

  // The user removes the model from Settings → Models mid-session.
  await removeCustomModel('gpt-5.6-sol[1m]');
  assert.equal(resolveContextWindowTokens({ backend: 'codex', model: 'gpt-5.6-sol[1m]' }), null,
    'the registry can no longer resolve it');

  const inst = instances.get(id);
  assert.equal(inst.contextWindowTokens, 1_000_000, 'the session keeps the number it was created with');
  const sessionId = inst.sessionId;

  // Relaunch the session (kill + resume, the real path a user takes). The sidecar
  // carries the last known capacity, `_doCreate` falls back to it, and the env
  // block hands the child THAT number. A live per-spawn re-resolve would now
  // yield null and silently omit both env vars, quietly reverting the session to
  // the CLI's ~200k assumption for an unrecognised model.
  // fake-claude writes no jsonl, so seed one at the cwd-encoded path the resume
  // pre-flight checks (mirrors tests/model-resume.test.mjs).
  const sessionDir = path.join(process.env.CLAUDE_PROJECTS_ROOT, encodeCwd(path.join(process.env.PROJECTS_ROOT, 'codex-del')));
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n');

  await api(baseUrl, 'DELETE', `/api/instances/${id}`);
  await waitFor(() => !instances.get(id) || !instances.get(id).proc);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'codex-del', mode: 'bypassPermissions', resume: sessionId,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await waitFor(() => instances.get(r.body.id).status === 'idle');
    assert.equal(r.body.backend, 'codex', 'the backend is recovered from the sidecar');
    assert.equal(r.body.model, 'gpt-5.6-sol[1m]', 'the exact id is recovered from the sidecar');
    assert.equal(r.body.contextWindowTokens, 1_000_000, 'carried capacity survives the deleted row');

    await waitFor(async () => { try { await fs.stat(envDump); return true; } catch { return false; } });
    const env = Object.fromEntries((await fs.readFile(envDump, 'utf8')).split('\n').filter(Boolean).map(l => {
      const eq = l.indexOf('='); return eq < 0 ? [l, ''] : [l.slice(0, eq), l.slice(eq + 1)];
    }));
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
  } finally {
    delete process.env.FAKE_CLAUDE_ENV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

// ── F4: capacity follows the model on a live switch, in BOTH directions ───
test('a live model switch moves capacity to the new model', async () => {
  const { id } = await spawnAndDump('claude-haiku-4-5', { project: 'sw-a' });
  const inst = instances.get(id);
  assert.equal(inst.contextWindowTokens, 200_000);

  // The CLI reports a genuine interactive switch to a 1M model.
  inst._trackModel('claude-sonnet-5');
  assert.equal(inst.model, 'claude-sonnet-5');
  assert.equal(inst.contextWindowTokens, 1_000_000, 'capacity must follow the switch upward');

  // …and back down. Retaining the larger number here would under-report the
  // fill on a session that is now capped at 200k.
  inst._trackModel('claude-haiku-4-5');
  assert.equal(inst.contextWindowTokens, 200_000, 'capacity must follow the switch downward');
});

test('a live switch to an out-of-catalog id nulls capacity rather than retaining the old model\'s', async () => {
  const { id } = await spawnAndDump('claude-haiku-4-5', { project: 'sw-b' });
  const inst = instances.get(id);
  assert.equal(inst.contextWindowTokens, 200_000);

  // A `claude-*` id the catalog doesn't know (a model shipped after this build).
  inst._trackModel('claude-future-9');
  assert.equal(inst.model, 'claude-future-9');
  // Retaining 200_000 here would publish the PREVIOUS model's window as this
  // model's measured denominator — `ctx 95% · 190k/200k` on a possibly-1M model.
  // Unknown must render as unknown.
  assert.equal(inst.contextWindowTokens, null,
    'an unresolvable window is null, never the outgoing model\'s number');
});

test('setModel ACCEPTS an out-of-catalog Claude id and reports its capacity as unknown', async () => {
  const { id } = await spawnAndDump('claude-haiku-4-5', { project: 'sw-c' });
  const inst = instances.get(id);
  assert.equal(inst.contextWindowTokens, 200_000);

  // A model Anthropic ships before this build's catalog learns it. Accepted on a
  // name-prefix test, deliberately: refusing would force a kill-and-respawn to
  // use it, and would contradict `spawn_instance`, which already accepts such an
  // id. Safety comes from capacity, not from the validator —
  await inst.setModel('claude-opus-9');
  assert.equal(inst.model, 'claude-opus-9', 'the switch goes through');
  // — the outgoing model's 200_000 must NOT be retained. Unknown renders `ctx —`;
  // keeping the old number would publish it as this model's measured cap.
  assert.equal(inst.contextWindowTokens, null,
    'an uncatalogued id has unknown capacity, never the previous model\'s');

  // A catalogued id still resolves its own window, so the null above is a real
  // "we don't know" rather than the resolver having broken.
  await inst.setModel('claude-sonnet-4-6');
  assert.equal(inst.model, 'claude-sonnet-4-6[1m]', 'the launch tag is applied server-side');
  assert.equal(inst.contextWindowTokens, 1_000_000);

  // A non-Claude-shaped id is still refused — the prefix test is a shape check,
  // not an absence of validation.
  await assert.rejects(() => inst.setModel('gpt-5.6-sol'), /invalid model/);
  assert.equal(inst.model, 'claude-sonnet-4-6[1m]', 'the refused switch changes nothing');
});


// ── N2: the silent-adoption branch must push the summary too ──────────────
test('adopting the account-default model pushes a summary so the chip is not `ctx —` all turn', () => {
  // A session spawned with no `--model` (the documented default) learns its model
  // only from system/init. The adoption branch is silent by design — no
  // model_changed — but it must still emit `status`, or the client keeps
  // contextWindowTokens:null until some unrelated refetch and the ctx chip reads
  // `ctx —` for the whole first turn. Unit-level: the branch needs this.model to
  // be null at call time, which a spawned instance has already passed.
  const inst = new Instance({
    id: 'n2', project: 'p', cwd: '/tmp/p', mode: 'plan', effort: 'high',
    thinking: 'adaptive', model: null, backend: CLAUDE_BACKEND_ID,
  });
  const statuses = [];
  const uiEvents = [];
  inst.on('status', (s) => statuses.push(s));
  inst.on('event', (e) => { if (e.subtype === 'model_changed') uiEvents.push(e); });

  inst._trackModel('claude-haiku-4-5');

  assert.equal(inst.model, 'claude-haiku-4-5');
  assert.equal(inst.contextWindowTokens, 200_000);
  assert.deepEqual(uiEvents, [], 'discovery is not a user-visible switch');
  assert.equal(statuses.length, 1, 'the summary must be pushed on adoption');
  assert.equal(statuses[0].contextWindowTokens, 200_000,
    'the pushed summary carries the newly-known capacity');
});
