// Ask-a-question about a session (POST /api/sessions/:sid/ask) and the shared
// cache-stable prompt shape every one-shot session call uses: the session text
// is the SYSTEM prompt (via --system-prompt-file), the task is the user message
// with the question last. Driven through tests/fake-claude-summarize.mjs; the
// gated R1 test at the bottom drives the real CLI.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { buildSessionPrompt, flattenTranscript } from '../src/summarize.ts';
import { orchStoreRoot, localPlace } from '../src/projects.ts';
import { runSessionOneShot, summarySpawnDir } from '../src/sessionOneShot.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');
const FAKE_SUMMARIZE = path.join(__dirname, 'fake-claude-summarize.mjs');

let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

const TURNS = [
  { type: 'user', message: { role: 'user', content: 'please add a cache to the router' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added an LRU cache.' }] } },
];

async function plantJsonl(projPath, sid, lines) {
  const dir = path.join(claudeProjectsRoot, projPath.replace(/[^A-Za-z0-9-]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

async function newSession(name, sid, lines = TURNS) {
  await api(baseUrl, 'POST', '/api/projects', { name });
  await plantJsonl(path.join(projectsRoot, name), sid, lines);
}

// Run `fn(files)` with CLAUDE_BIN pointed at the fake and per-call capture
// files in a fresh temp dir; extra FAKE_* env goes in `env`.
async function withFake(env, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ask-test-'));
  const saved = {};
  const set = { CLAUDE_BIN: `${process.execPath} ${FAKE_SUMMARIZE}`, ...env };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(dir); }
  finally {
    for (const k of Object.keys(set)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    for (const k of ['FAKE_SUMMARIZE_SYSTEM_PROMPT_OUT', 'FAKE_SUMMARIZE_STDIN_FILE', 'FAKE_SUMMARIZE_ARGV_FILE', 'FAKE_SUMMARIZE_PID_FILE']) delete process.env[k];
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// One call through the fake; returns the response plus what the fake saw.
async function callCaptured(dir, tag, method, urlPath, body) {
  const sysOut = path.join(dir, `${tag}-sys.json`);
  const stdinOut = path.join(dir, `${tag}-stdin.txt`);
  const argvOut = path.join(dir, `${tag}-argv.json`);
  process.env.FAKE_SUMMARIZE_SYSTEM_PROMPT_OUT = sysOut;
  process.env.FAKE_SUMMARIZE_STDIN_FILE = stdinOut;
  process.env.FAKE_SUMMARIZE_ARGV_FILE = argvOut;
  const r = await api(baseUrl, method, urlPath, body);
  return {
    r,
    sys: JSON.parse(await fs.readFile(sysOut, 'utf8').catch(() => 'null')),
    stdin: await fs.readFile(stdinOut, 'utf8').catch(() => null),
    argv: JSON.parse(await fs.readFile(argvOut, 'utf8').catch(() => 'null')),
  };
}

// ---------------------------------------------------------------------------
// Prompt shape (unit)
// ---------------------------------------------------------------------------

describe('buildSessionPrompt', () => {
  // A1 pins: the cache prefix does not depend on the question, and the
  // question is the tail of the user message.
  test('A1: two questions build a byte-identical system prompt; the user message ends with the question', () => {
    const conv = 'User: hello\n\nAssistant: hi';
    const a = buildSessionPrompt(conv, 'TASK\n\nQUESTION:\nwhat did the user say?');
    const b = buildSessionPrompt(conv, 'TASK\n\nQUESTION:\nand the assistant?');
    assert.equal(a.system, b.system);
    assert.ok(a.user.endsWith('what did the user say?'));
    assert.ok(!a.system.includes('what did the user say?'));
    assert.ok(a.system.includes(conv));
  });
});

describe('flattenTranscript', () => {
  // B1 pins: per-line metadata and tool-only turns never reach the prefix text.
  test('B1: lines differing only in uuid/timestamp/sessionId, plus an appended tool-only turn, flatten to identical text', async () => {
    const cwd = path.join(projectsRoot, 'flat');
    await fs.mkdir(cwd, { recursive: true });
    const mk = (meta) => TURNS.map((t, i) => ({ ...t, ...meta(i) }));
    await plantJsonl(cwd, 'flat-a', mk(i => ({ uuid: `u-${i}`, timestamp: '2026-01-01T00:00:00Z', sessionId: 'flat-a' })));
    await plantJsonl(cwd, 'flat-b', [
      ...mk(i => ({ uuid: `zzz-${i}`, timestamp: '2030-05-05T10:00:00Z', sessionId: 'flat-b' })),
      { type: 'assistant', uuid: 'tool-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', uuid: 'tool-2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } },
    ]);
    const place = localPlace(cwd);
    const a = await flattenTranscript('flat-a', place);
    const b = await flattenTranscript('flat-b', place);
    assert.equal(a.conversationText, b.conversationText);
  });
});

// ---------------------------------------------------------------------------
// Route (through the fake CLI)
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:sid/ask', () => {
  // C1 pins: the end-to-end prefix is question-independent and the question
  // is the last thing on stdin.
  test('C1: two asks send byte-identical system-prompt files, and each stdin ends with its question', async () => {
    await newSession('ask-c1', 'sid-c1');
    await withFake({}, async (dir) => {
      const one = await callCaptured(dir, 'one', 'POST', '/api/sessions/sid-c1/ask', { question: 'what was added?' });
      const two = await callCaptured(dir, 'two', 'POST', '/api/sessions/sid-c1/ask', { question: '  and by whom?  ' });
      assert.equal(one.r.status, 200, JSON.stringify(one.r.body));
      assert.equal(one.sys.content, two.sys.content);
      assert.match(one.sys.content, /add a cache to the router/);
      assert.ok(one.stdin.endsWith('what was added?'));
      assert.ok(two.stdin.endsWith('and by whom?'), 'the question is trimmed and last');
      assert.ok(!one.sys.content.includes('what was added?'));
    });
  });

  // C2 pins: summarize→ask and tier→tier share one cached prefix, and the
  // title's project hint never enters it.
  test('C2: summary tiers, the title (with a project hint) and an ask send the same system-prompt bytes', async () => {
    await newSession('ask-c2', 'sid-c2');
    await withFake({}, async (dir) => {
      const sums = [];
      for (const length of ['short', 'long', 'title']) {
        sums.push(await callCaptured(dir, length, 'POST', '/api/sessions/sid-c2/summary', { length }));
      }
      const ask = await callCaptured(dir, 'ask', 'POST', '/api/sessions/sid-c2/ask', { question: 'why?' });
      for (const s of sums) assert.equal(s.sys.content, ask.sys.content);
      assert.match(sums[2].stdin, /"ask-c2"/, 'the hint is in the user message');
      assert.ok(!ask.sys.content.includes('ask-c2'));
    });
  });

  // C3 pins: the prefix-stability flags ride both paths and the conversation
  // is not on stdin.
  test("C3: ask and summary both pass --system-prompt-file, --tools '', --strict-mcp-config, --no-session-persistence; stdin carries no conversation text", async () => {
    await newSession('ask-c3', 'sid-c3');
    await withFake({}, async (dir) => {
      const calls = [
        await callCaptured(dir, 'ask', 'POST', '/api/sessions/sid-c3/ask', { question: 'q' }),
        await callCaptured(dir, 'sum', 'POST', '/api/sessions/sid-c3/summary', { length: 'short' }),
      ];
      for (const c of calls) {
        assert.ok(c.argv.includes('--system-prompt-file'));
        assert.ok(c.argv.includes('--strict-mcp-config'));
        assert.ok(c.argv.includes('--no-session-persistence'));
        assert.equal(c.argv[c.argv.indexOf('--tools') + 1], '');
        assert.doesNotMatch(c.stdin, /add a cache to the router/);
      }
    });
  });

  // C4 pins: an ask leaves no server-side record and no leftover file.
  test('C4: an ask stores nothing (sessions.json unchanged, no CLI jsonl, system-prompt file removed)', async () => {
    await newSession('ask-c4', 'sid-c4');
    const storeFile = path.join(orchStoreRoot(), 'sessions.json');
    const before = await fs.readFile(storeFile, 'utf8').catch(() => null);
    await withFake({ FAKE_SUMMARIZE_WRITE_JSONL: '1' }, async (dir) => {
      const c = await callCaptured(dir, 'ask', 'POST', '/api/sessions/sid-c4/ask', { question: 'q' });
      assert.equal(c.r.status, 200);
      assert.ok(c.argv.includes('--no-session-persistence'));
      const jsonl = path.join(claudeProjectsRoot, summarySpawnDir().replace(/[^A-Za-z0-9-]/g, '-'), `${c.argv[c.argv.indexOf('--session-id') + 1]}.jsonl`);
      assert.equal(await fs.stat(jsonl).catch(() => null), null, 'no CLI transcript was written');
      const sum = await api(baseUrl, 'GET', '/api/sessions/sid-c4/summary');
      assert.equal(sum.body.data.short, null);
      assert.equal(await fs.stat(c.sys.path).catch(() => null), null, 'the system-prompt file is gone');
    });
    assert.equal(await fs.readFile(storeFile, 'utf8').catch(() => null), before);
  });

  // C5 pins: the cache counters from the envelope are the verification channel.
  test('C5: usage cache_read/creation tokens from the envelope are returned; absent usage reads null', async () => {
    await newSession('ask-c5', 'sid-c5');
    await withFake({ FAKE_SUMMARIZE_USAGE: JSON.stringify({ cache_read_input_tokens: 120, cache_creation_input_tokens: 'x' }) }, async () => {
      const r = await api(baseUrl, 'POST', '/api/sessions/sid-c5/ask', { question: 'q' });
      assert.deepEqual(r.body.usage, { cacheReadInputTokens: 120, cacheCreationInputTokens: null });
    });
    await withFake({}, async () => {
      const r = await api(baseUrl, 'POST', '/api/sessions/sid-c5/ask', { question: 'q' });
      assert.deepEqual(r.body.usage, { cacheReadInputTokens: null, cacheCreationInputTokens: null });
      assert.equal(r.body.answer, 'This is a canned test summary of the session.');
      assert.equal(typeof r.body.costUsd, 'number');
    });
  });

  // C6 pins: a bad question is refused before anything is spawned.
  test('C6: a missing, non-string or whitespace question answers 400 and spawns nothing', async () => {
    await newSession('ask-c6', 'sid-c6');
    await withFake({}, async (dir) => {
      for (const body of [{}, { question: 7 }, { question: '   ' }]) {
        const c = await callCaptured(dir, 'bad', 'POST', '/api/sessions/sid-c6/ask', body);
        assert.equal(c.r.status, 400, JSON.stringify(body));
        assert.equal(c.argv, null, 'no child was spawned');
      }
    });
  });

  // C7 pins: an unknown session is a clean 404.
  test('C7: an unknown session answers 404', async () => {
    const r = await api(baseUrl, 'POST', '/api/sessions/nope-sid/ask', { question: 'q' });
    assert.equal(r.status, 404);
  });

  // C8 pins: a closed dialog (client disconnect) costs nothing further.
  test('C8: a client disconnect kills the child and removes the system-prompt file', async () => {
    await newSession('ask-c8', 'sid-c8');
    await withFake({ FAKE_SUMMARIZE_HANG: '1' }, async (dir) => {
      const pidFile = path.join(dir, 'pid');
      const sysOut = path.join(dir, 'sys.json');
      process.env.FAKE_SUMMARIZE_PID_FILE = pidFile;
      process.env.FAKE_SUMMARIZE_SYSTEM_PROMPT_OUT = sysOut;
      const ac = new AbortController();
      const req = fetch(`${baseUrl}/api/sessions/sid-c8/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'q' }), signal: ac.signal,
      }).catch(() => null);
      const pid = Number(await waitFor(() => fs.readFile(pidFile, 'utf8')));
      const { path: promptPath } = JSON.parse(await fs.readFile(sysOut, 'utf8'));
      assert.ok(await fs.stat(promptPath), 'the file exists while the child runs');
      ac.abort();
      await req;
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
      await waitFor(async () => (await fs.stat(promptPath).catch(() => null)) === null);
    });
  });

  // C9 pins: a failing CLI surfaces an error and still cleans up.
  test('C9: a CLI failure answers an error and still removes the system-prompt file', async () => {
    await newSession('ask-c9', 'sid-c9');
    await withFake({ FAKE_SUMMARIZE_EXIT_CODE: '3' }, async (dir) => {
      const c = await callCaptured(dir, 'fail', 'POST', '/api/sessions/sid-c9/ask', { question: 'q' });
      assert.equal(c.r.status, 500);
      assert.match(JSON.stringify(c.r.body), /fake failure/);
      assert.equal(await fs.stat(c.sys.path).catch(() => null), null);
    });
  });
});

describe('runSessionOneShot abort window', () => {
  // Runs `fn(tmp, argvOut)` with TMPDIR on a private dir, the fake as CLAUDE_BIN
  // and its argv capture file (written only if a child actually starts).
  async function inPrivateTmp(fn) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ask-abort-'));
    const argvOut = path.join(tmp, 'argv.json');
    const keys = ['TMPDIR', 'CLAUDE_BIN', 'FAKE_SUMMARIZE_ARGV_FILE'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    process.env.TMPDIR = tmp;
    process.env.CLAUDE_BIN = `${process.execPath} ${FAKE_SUMMARIZE}`;
    process.env.FAKE_SUMMARIZE_ARGV_FILE = argvOut;
    try { await fn(tmp, argvOut); }
    finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  const leftovers = async (tmp) => (await fs.readdir(tmp)).filter(n => n.startsWith('cc-oneshot-'));

  // D1 pins only the region between the entry guard and the first later read of
  // `aborted`: a signal that reports aborted from its second read on makes the
  // call reject AbortError with no child and no temp dir. It does not pin WHERE
  // that later read sits relative to the fs awaits; D2 does.
  test('D1: a signal aborted after the entry guard rejects AbortError, spawns no child, and removes the temp dir', async () => {
    await inPrivateTmp(async (tmp, argvOut) => {
      let reads = 0;
      const signal = { get aborted() { return ++reads > 1; }, addEventListener() {}, removeEventListener() {} };
      await assert.rejects(runSessionOneShot({ systemPrompt: 's', prompt: 'p', signal }), { name: 'AbortError' });
      await new Promise(r => setTimeout(r, 200));
      assert.equal(await fs.stat(argvOut).catch(() => null), null, 'no child ran');
      assert.deepEqual(await leftovers(tmp), []);
    });
  });

  // D2 pins: a REAL abort fired inside the last fs await before spawn (the
  // system-prompt writeFile) is still observed: AbortError, no child, no temp dir.
  test('D2: a real abort during the system-prompt write rejects AbortError, spawns no child, and removes the temp dir', async () => {
    await inPrivateTmp(async (tmp, argvOut) => {
      const ac = new AbortController();
      const origWrite = fs.writeFile;
      fs.writeFile = async function (file, ...rest) {
        const r = await origWrite.call(this, file, ...rest);
        if (String(file).endsWith('system-prompt.txt')) ac.abort();
        return r;
      };
      try {
        await assert.rejects(runSessionOneShot({ systemPrompt: 's', prompt: 'p', signal: ac.signal }), { name: 'AbortError' });
      } finally { fs.writeFile = origWrite; }
      await new Promise(r => setTimeout(r, 200));
      assert.equal(await fs.stat(argvOut).catch(() => null), null, 'no child ran');
      assert.deepEqual(await leftovers(tmp), []);
    });
  });
});

// ---------------------------------------------------------------------------
// Real CLI (gated)
// ---------------------------------------------------------------------------

describe('real CLI', { skip: process.env.RUN_REAL_CLAUDE !== '1' }, () => {
  // R1 pins: a later call on an unchanged session reads the prompt cache, for
  // ask→ask and for summary→ask.
  test('R1: a second question on an unchanged session reads the cache, and so does an ask after a summary', { timeout: 240_000 }, async () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'router', 'cache', 'token', 'prompt', 'merge', 'branch'];
    const lines = Array.from({ length: 60 }, (_, i) => ({
      type: i % 2 ? 'assistant' : 'user',
      message: i % 2
        ? { role: 'assistant', content: [{ type: 'text', text: Array.from({ length: 60 }, (_, j) => words[(i * 7 + j * 3) % 10] + (i * 31 + j)).join(' ') }] }
        : { role: 'user', content: Array.from({ length: 60 }, (_, j) => words[(i * 5 + j * 11) % 10] + (i * 17 + j)).join(' ') },
    }));
    await newSession('ask-r1', 'sid-r1', lines);
    const first = await api(baseUrl, 'POST', '/api/sessions/sid-r1/ask', { question: 'What is the first word of the conversation?' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await api(baseUrl, 'POST', '/api/sessions/sid-r1/ask', { question: 'How many turns are there?' });
    assert.ok(second.body.usage.cacheReadInputTokens > 0, JSON.stringify(second.body.usage));
    const sum = await api(baseUrl, 'POST', '/api/sessions/sid-r1/summary', { length: 'short' });
    assert.equal(sum.status, 200);
    const third = await api(baseUrl, 'POST', '/api/sessions/sid-r1/ask', { question: 'Is there a branch word?' });
    assert.ok(third.body.usage.cacheReadInputTokens > 0, JSON.stringify(third.body.usage));
  });
});
