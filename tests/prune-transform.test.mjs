// Unit coverage of the Prune transform (src/sessionPrune.js).
//
// The invariants asserted here are load-bearing, not stylistic — several were
// derived by probing the real CLI's transcript-replay behaviour and would be
// invisible to a reviewer reading only this repo. See the header comment in
// src/sessionPrune.js and docs/architecture.md → Prune.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CWD = '/tmp/prune-fixture-project';

async function withStore(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prune-store-'));
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = root;
  try { return await fn(root); }
  finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
  }
}

async function seed(lines, { subAgents = null } = {}) {
  const { encodeCwd, claudeProjectsRoot } = await import('../src/projects.js');
  const dir = path.join(claudeProjectsRoot(), encodeCwd(CWD));
  await fs.mkdir(dir, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  if (subAgents) {
    const sub = path.join(dir, sid, 'subagents');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'agent-a1.jsonl'), subAgents);
  }
  return { dir, sid };
}

const bigText = 'x'.repeat(4000);

// A representative session: a user turn that Reads a file and Bashes, a second
// user turn, thinking blocks, and a sidechain line that must survive untouched.
function scenario() {
  return [
    { type: 'user', uuid: 'u1', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant', uuid: 'a1', sessionId: 'old', message: { id: 'm1', role: 'assistant', content: [
      { type: 'thinking', thinking: bigText, signature: 'sig-1' },
    ] } },
    { type: 'assistant', uuid: 'a2', sessionId: 'old', message: { id: 'm1', role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/prune-fixture-project/foo.ts' } },
    ] } },
    { type: 'user', uuid: 'u2', sessionId: 'old',
      toolUseResult: { type: 'text', file: { filePath: '/tmp/prune-fixture-project/foo.ts', content: bigText } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigText }] } },
    { type: 'assistant', uuid: 'a3', sessionId: 'old', message: { id: 'm2', role: 'assistant', content: [
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: `echo ${bigText}`, description: 'echo' } },
    ] } },
    { type: 'user', uuid: 'u3', sessionId: 'old', toolUseResult: 'ok',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: bigText }] } },
    // A sidechain line — never pruned, never counted.
    { type: 'assistant', uuid: 's1', sessionId: 'old', isSidechain: true, message: { id: 'ms', role: 'assistant', content: [
      { type: 'thinking', thinking: bigText, signature: 'sig-sc' },
      { type: 'text', text: bigText },
    ] } },
    { type: 'user', uuid: 'u4', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant', uuid: 'a4', sessionId: 'old', message: { id: 'm3', role: 'assistant', content: [
      { type: 'text', text: 'done' },
    ] } },
  ];
}

async function readOut(dir, sid) {
  const text = await fs.readFile(path.join(dir, `${sid}.jsonl`), 'utf8');
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('prune stubs the pruned region and leaves the newest turn verbatim', async () => {
  await withStore(async () => {
    const { pruneSessionToNewId } = await import('../src/sessionPrune.js');
    const lines = scenario();
    const { dir, sid } = await seed(lines);
    const originalBytes = await fs.readFile(path.join(dir, `${sid}.jsonl`));

    const { newSessionId, saved } = await pruneSessionToNewId({
      cwd: CWD, sessionId: sid, cutTurnIndex: 1, pruneThinking: true, inputMode: 'truncate',
    });
    const out = await readOut(dir, newSessionId);

    // The original is never mutated.
    assert.deepEqual(await fs.readFile(path.join(dir, `${sid}.jsonl`)), originalBytes);
    // Never delete an entry — this is what keeps the parentUuid chain and the
    // tool_use/tool_result pairing invariant safe without any relinking. The two
    // trailing lines are the resume-picker metadata writeSessionMetadata appends,
    // exactly as fork does.
    const core = out.filter(o => o.uuid !== undefined);
    assert.deepEqual(out.slice(core.length).map(o => o.type), ['last-prompt', 'permission-mode']);
    assert.equal(core.length, lines.length);
    assert.deepEqual(core.map(o => o.uuid), lines.map(o => o.uuid));
    assert.deepEqual(core.map(o => o.parentUuid), lines.map(o => o.parentUuid));

    const byUuid = Object.fromEntries(out.map(o => [o.uuid, o]));
    // Tool output stubbed…
    assert.match(byUuid.u2.message.content[0].content[0].text, /^\[pruned: 3\.9 KB\]$/);
    // …and the Bash output too (string stub — not a Read/Write result).
    assert.match(byUuid.u3.message.content[0].content, /^\[pruned: 3\.9 KB\]$/);
    // Tool input truncated but the key set is intact.
    assert.deepEqual(Object.keys(byUuid.a3.message.content[0].input), ['command', 'description']);
    assert.match(byUuid.a3.message.content[0].input.command, /chars pruned\]$/);
    assert.equal(byUuid.a3.message.content[0].input.description, 'echo');
    // Thinking stubbed, signature retained.
    assert.equal(byUuid.a1.message.content[0].thinking, '[pruned: thinking]');
    assert.equal(byUuid.a1.message.content[0].signature, 'sig-1');
    // Newest turn verbatim.
    assert.equal(byUuid.a4.message.content[0].text, 'done');
    assert.ok(saved.toolOutputs > 0 && saved.thinking > 0 && saved.toolInputs > 0);
  });
});

test('a Read tool_use keeps file_path, and its result becomes a block array', async () => {
  // The two halves of the read-before-edit contract. Dropping `file_path` makes
  // every later Edit fail; keeping the result a STRING would leave the harness
  // asserting the file is in context when only a size marker is.
  await withStore(async () => {
    const { pruneSessionToNewId, PRUNE_STUB_AS_BLOCKS } = await import('../src/sessionPrune.js');
    assert.equal(PRUNE_STUB_AS_BLOCKS, true);
    const { dir, sid } = await seed(scenario());
    for (const inputMode of ['truncate', 'minimal']) {
      const { newSessionId } = await pruneSessionToNewId({
        cwd: CWD, sessionId: sid, cutTurnIndex: 1, pruneThinking: false, inputMode,
      });
      const out = await readOut(dir, newSessionId);
      const byUuid = Object.fromEntries(out.map(o => [o.uuid, o]));
      assert.equal(
        byUuid.a2.message.content[0].input.file_path,
        '/tmp/prune-fixture-project/foo.ts',
        `file_path must survive ${inputMode} mode`,
      );
      assert.ok(Array.isArray(byUuid.u2.message.content[0].content),
        'a pruned Read result must be a block array so readFileState re-arms');
      assert.ok(!Array.isArray(byUuid.u3.message.content[0].content),
        'a non-seeding tool (Bash) keeps the cheaper string stub');
    }
  });
});

test('toolUseResult, timestamps, is_error and sidechain lines are never touched', async () => {
  await withStore(async () => {
    const { pruneSessionToNewId } = await import('../src/sessionPrune.js');
    const lines = scenario();
    lines[3].timestamp = '2026-01-01T00:00:00.000Z';
    lines[5].message.content[0].is_error = true;
    const { dir, sid } = await seed(lines);
    const { newSessionId } = await pruneSessionToNewId({
      cwd: CWD, sessionId: sid, cutTurnIndex: 1, pruneThinking: true, inputMode: 'minimal',
    });
    const out = await readOut(dir, newSessionId);
    const byUuid = Object.fromEntries(out.map(o => [o.uuid, o]));

    // toolUseResult is a disk-only sidecar AND the CLI's "is this a human turn"
    // discriminator — pruning it saves no context and corrupts turn counting.
    assert.deepEqual(byUuid.u2.toolUseResult, lines[3].toolUseResult);
    assert.equal(byUuid.u3.toolUseResult, 'ok');
    assert.equal(byUuid.u2.timestamp, '2026-01-01T00:00:00.000Z');
    assert.equal(byUuid.u3.message.content[0].is_error, true);
    // Sidechain content is byte-identical.
    assert.deepEqual(byUuid.s1.message.content, lines[6].message.content);
    // sessionId is rewritten everywhere for self-consistency.
    assert.ok(out.every(o => o.sessionId === newSessionId));
  });
});

test('thinking in an entry with an unresolved tool_use is exempt', async () => {
  await withStore(async () => {
    const { pruneSessionToNewId } = await import('../src/sessionPrune.js');
    const { dir, sid } = await seed([
      { type: 'user', uuid: 'u1', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', uuid: 'a1', sessionId: 'old', message: { id: 'm1', role: 'assistant', content: [
        { type: 'thinking', thinking: bigText, signature: 's' },
      ] } },
      { type: 'user', uuid: 'u2', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'again' }] } },
      // Same message.id as the dangling tool_use below — the CLI splits one
      // logical assistant message across lines, so the exemption is by id.
      { type: 'assistant', uuid: 'a2', sessionId: 'old', message: { id: 'm2', role: 'assistant', content: [
        { type: 'thinking', thinking: bigText, signature: 's2' },
      ] } },
      { type: 'assistant', uuid: 'a3', sessionId: 'old', message: { id: 'm2', role: 'assistant', content: [
        { type: 'tool_use', id: 'dangling', name: 'Read', input: { file_path: '/x' } },
      ] } },
    ]);
    const { newSessionId } = await pruneSessionToNewId({
      cwd: CWD, sessionId: sid, cutTurnIndex: 1, pruneThinking: true, inputMode: 'truncate',
    });
    const byUuid = Object.fromEntries((await readOut(dir, newSessionId)).map(o => [o.uuid, o]));
    assert.equal(byUuid.a1.message.content[0].thinking, '[pruned: thinking]');
    assert.equal(byUuid.a2.message.content[0].thinking, bigText, 'unresolved tool_use exempts its thinking');
  });
});

test('a stub that would be larger than the original is skipped', async () => {
  await withStore(async () => {
    const { pruneSessionToNewId, analyzeSessionForPrune } = await import('../src/sessionPrune.js');
    const { dir, sid } = await seed([
      { type: 'user', uuid: 'u1', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', uuid: 'a1', sessionId: 'old', message: { id: 'm1', role: 'assistant', content: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ] } },
      { type: 'user', uuid: 'u2', sessionId: 'old', toolUseResult: 'x',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'user', uuid: 'u3', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } },
    ]);
    const analysis = await analyzeSessionForPrune({ cwd: CWD, sessionId: sid });
    for (const t of analysis.turns) {
      assert.ok(t.thinking >= 0 && t.toolOutput >= 0 && t.toolInputTruncatable >= 0 && t.toolInputMinimal >= 0,
        'savings are never negative — pruning must not inflate the context');
    }
    const { newSessionId, saved } = await pruneSessionToNewId({
      cwd: CWD, sessionId: sid, cutTurnIndex: 1, pruneThinking: true, inputMode: 'minimal',
    });
    assert.deepEqual(saved, { thinking: 0, toolInputs: 0, toolOutputs: 0 });
    const byUuid = Object.fromEntries((await readOut(dir, newSessionId)).map(o => [o.uuid, o]));
    assert.equal(byUuid.a1.message.content[0].thinking, '', 'empty thinking left alone');
    assert.equal(byUuid.u2.message.content[0].content, 'ok', 'tiny output left alone');
  });
});

test('analysis excludes sidechain entries and toolUseResult bytes', async () => {
  await withStore(async () => {
    const { analyzeSessionForPrune } = await import('../src/sessionPrune.js');
    const { sid } = await seed(scenario());
    const a = await analyzeSessionForPrune({ cwd: CWD, sessionId: sid });
    assert.equal(a.turnCount, 2);
    assert.equal(a.turns[1].total, 3, 'the newest turn is just "second" + "done"');
    // The sidechain line alone carries ~2000 tokens (4k of thinking + 4k of
    // text). Counting it would inflate the reported saving by half again while
    // the model's real context barely moves — worse than showing no number.
    assert.ok(a.totalTokens > 4000 && a.totalTokens < 5000,
      `sidechain leaked into the estimate (${a.totalTokens})`);
    assert.ok(a.turns[0].toolOutput > 1900, 'both tool outputs land in turn 0');
    assert.ok(a.turns[0].toolInputMinimal > a.turns[0].toolInputTruncatable,
      'minimal mode must save more than truncate mode');
  });
});

test('sub-agent transcripts follow the session to its new id', async () => {
  await withStore(async () => {
    const { pruneSessionToNewId } = await import('../src/sessionPrune.js');
    const { dir, sid } = await seed(scenario(), { subAgents: '{"type":"assistant"}\n' });
    const { newSessionId } = await pruneSessionToNewId({
      cwd: CWD, sessionId: sid, cutTurnIndex: 1, pruneThinking: false, inputMode: 'truncate',
    });
    // Without this copy every sidechain silently vanishes from the pruned
    // session's transcript view (loadSubAgentTranscript keys off the sessionId).
    assert.equal(
      await fs.readFile(path.join(dir, newSessionId, 'subagents', 'agent-a1.jsonl'), 'utf8'),
      '{"type":"assistant"}\n',
    );
  });
});

test('truncate mode never splits a surrogate pair', async () => {
  // The default mode slices on code UNITS. A pair straddling the cut would leave
  // a lone high surrogate — no valid UTF-8 encoding — written into a jsonl whose
  // entire contract is that it resumes cleanly. Astral-plane characters turn up
  // in exactly the values this truncates.
  await withStore(async () => {
    const { pruneSessionToNewId, PRUNE_INPUT_MAX } = await import('../src/sessionPrune.js');
    // '😀' is a surrogate pair, so at PRUNE_INPUT_MAX-1 it straddles the cut.
    const straddling = 'a'.repeat(PRUNE_INPUT_MAX - 1) + '😀' + 'b'.repeat(50);
    // …and one where the pair sits wholly inside the kept prefix.
    const aligned = 'a'.repeat(PRUNE_INPUT_MAX - 2) + '😀' + 'b'.repeat(50);
    const { dir, sid } = await seed([
      { type: 'user', uuid: 'u1', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', uuid: 'a1', sessionId: 'old', message: { id: 'm1', role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/x', old_string: straddling, new_string: aligned } },
      ] } },
      { type: 'user', uuid: 'r1', sessionId: 'old', toolUseResult: 'ok',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'user', uuid: 'u2', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } },
    ]);
    const { newSessionId } = await pruneSessionToNewId({
      cwd: CWD, sessionId: sid, cutTurnIndex: 1, pruneThinking: false, inputMode: 'truncate',
    });

    // `JSON.stringify` writes a well-formed astral character as literal UTF-8
    // bytes but escapes a LONE surrogate as `\ud83d`. So the presence of any
    // surrogate-range \u escape in the file is itself the bug signature — no
    // intact pair can produce one.
    const raw = await fs.readFile(path.join(dir, `${newSessionId}.jsonl`), 'utf8');
    assert.doesNotMatch(raw, /\\ud[89ab][0-9a-f]{2}/i,
      'a lone surrogate was escaped into the pruned jsonl');

    const byUuid = Object.fromEntries((await readOut(dir, newSessionId)).map(o => [o.uuid, o]));
    const { old_string: cutOld, new_string: cutNew } = byUuid.a1.message.content[0].input;
    for (const [label, s] of [['old_string', cutOld], ['new_string', cutNew]]) {
      assert.match(s, /chars pruned\]$/, `${label} should have been truncated`);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          assert.ok(next >= 0xdc00 && next <= 0xdfff, `${label}: lone high surrogate at ${i}`);
          i++;
        } else {
          assert.ok(!(c >= 0xdc00 && c <= 0xdfff), `${label}: lone low surrogate at ${i}`);
        }
      }
      assert.equal(s, Buffer.from(s, 'utf8').toString('utf8'), `${label} is not UTF-8 round-trippable`);
    }
    // The straddling pair is dropped whole (one unit shorter); the aligned one is kept.
    assert.ok(!cutOld.includes('😀'), 'a straddling pair is dropped rather than split');
    assert.ok(cutNew.includes('😀'), 'a pair inside the kept prefix survives intact');
    // The reported count must reflect what was actually kept.
    assert.match(cutOld, new RegExp(`\\[\\+${straddling.length - (PRUNE_INPUT_MAX - 1)} chars pruned\\]$`));
  });
});

test('the savings preview equals what the transform actually saves', async () => {
  // Invariant 10 holds by construction (both passes call pruneBlock), but
  // "by construction" is exactly the kind of guarantee that quietly stops being
  // true. The other assertions in this file are one-sided lower bounds and would
  // not notice an analysis pass that reported 10x the real figure.
  await withStore(async () => {
    const { analyzeSessionForPrune, pruneSessionToNewId } = await import('../src/sessionPrune.js');
    const { sid } = await seed(scenario());
    const analysis = await analyzeSessionForPrune({ cwd: CWD, sessionId: sid });

    for (const inputMode of ['truncate', 'minimal']) {
      for (const pruneThinking of [true, false]) {
        for (let cut = 0; cut <= analysis.turnCount - 1; cut++) {
          const { saved } = await pruneSessionToNewId({
            cwd: CWD, sessionId: sid, cutTurnIndex: cut, pruneThinking, inputMode,
          });
          // Same arithmetic the dialog does: sum the selected prefix per
          // category, with thinking summed over ALL turns (it is global).
          const prefix = analysis.turns.slice(0, cut);
          const expected = {
            thinking: pruneThinking ? analysis.turns.reduce((a, t) => a + t.thinking, 0) : 0,
            toolInputs: prefix.reduce((a, t) => a + (inputMode === 'minimal' ? t.toolInputMinimal : t.toolInputTruncatable), 0),
            toolOutputs: prefix.reduce((a, t) => a + t.toolOutput, 0),
          };
          assert.deepEqual(saved, expected,
            `preview drifted from the transform (cut=${cut}, ${inputMode}, thinking=${pruneThinking})`);
        }
      }
    }
  });
});

test('the savings denominator counts attachments, which are in context', async () => {
  await withStore(async () => {
    const { analyzeSessionForPrune } = await import('../src/sessionPrune.js');
    const lines = scenario();
    // A CLAUDE.md injection: never pruned, but genuinely in the model's context,
    // so omitting it from the denominator over-reports the percentage saved.
    lines.splice(1, 0, {
      type: 'attachment', uuid: 'at1', sessionId: 'old',
      attachment: { type: 'nested_memory', path: '/CLAUDE.md', content: 'z'.repeat(4000) },
    });
    const { sid } = await seed(lines);
    const a = await analyzeSessionForPrune({ cwd: CWD, sessionId: sid });
    assert.ok(a.totalTokens > 5000,
      `attachment excluded from the denominator (${a.totalTokens})`);
  });
});

test('the cut is capped so the newest turn always survives', async () => {
  await withStore(async () => {
    const { pruneSessionToNewId } = await import('../src/sessionPrune.js');
    const { sid } = await seed(scenario());
    await assert.rejects(
      () => pruneSessionToNewId({ cwd: CWD, sessionId: sid, cutTurnIndex: 2 }),
      /cutTurnIndex must be an integer in 0…1/,
    );
    await assert.rejects(
      () => pruneSessionToNewId({ cwd: CWD, sessionId: sid, cutTurnIndex: 1, inputMode: 'nope' }),
      /inputMode must be/,
    );
  });
});

// ── invariant 6: exempt tools ───────────────────────────────────────────────
//
// AskUserQuestion and the CORE conductor MCP namespace are copied verbatim; the
// two bulk-output carve-outs, plugin-namespaced tools and foreign MCP servers
// stay prunable. Every payload below is `bigText`-sized so a "prunable"
// assertion can never pass because the never-inflate skip fired.

const LONG_Q = 'Which approach should I take? ' + 'q'.repeat(4000);
const LONG_DESC = 'd'.repeat(4000);

// One assistant tool_use + the user tool_result answering it.
function callPair(tag, name, input) {
  return [
    { type: 'assistant', uuid: `a_${tag}`, sessionId: 'old', message: { id: `m_${tag}`, role: 'assistant', content: [
      { type: 'tool_use', id: `t_${tag}`, name, input },
    ] } },
    { type: 'user', uuid: `r_${tag}`, sessionId: 'old', toolUseResult: 'ok', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `t_${tag}`, content: bigText },
    ] } },
  ];
}

// Turn 0 holds one call pair per tool class; turn 1 is the verbatim newest turn.
function exemptScenario() {
  return [
    { type: 'user', uuid: 'u1', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
    ...callPair('uq', 'AskUserQuestion', { questions: [
      { question: LONG_Q, header: 'Approach', multiSelect: false,
        options: [{ label: 'Rewrite', description: LONG_DESC }, { label: 'Patch', description: LONG_DESC }] },
    ] }),
    ...callPair('core', 'mcp__code-conductor__spawn_instance', { prompt: bigText, project: 'demo' }),
    // Same tail as the plugin tool below — a prefix-only match cannot tell these
    // two apart, so they are asserted against each other in ONE prune run.
    ...callPair('tail', 'mcp__code-conductor__file_task', { description: bigText }),
    ...callPair('plug', 'mcp__code-conductor__code-kanban__file_task', { description: bigText }),
    // A plugin id that does NOT start with `code-`. Every first-party plugin
    // does, so a fixture of only those cannot tell the `__` discriminator apart
    // from a `code-` one — and a third-party plugin would then be exempted, its
    // bulk output copied verbatim into every pruned session.
    ...callPair('thirdparty', 'mcp__code-conductor__acme-tools__run', { script: bigText }),
    ...callPair('read', 'mcp__code-conductor__project_read', { path: 'src/a.js', pattern: bigText }),
    ...callPair('bash', 'mcp__code-conductor__project_bash', { command: bigText }),
    ...callPair('other', 'mcp__otherserver__do_thing', { payload: bigText }),
    { type: 'user', uuid: 'u2', sessionId: 'old', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant', uuid: 'a_done', sessionId: 'old', message: { id: 'm_done', role: 'assistant', content: [
      { type: 'text', text: 'done' },
    ] } },
  ];
}

const STUBBED_RESULT = '[pruned: 3.9 KB]';

// Assert a tool input value was genuinely REPLACED BY A STUB — not merely
// "different from the original". Each mode has one exact shape.
function assertStubbedInput(value, inputMode, label) {
  if (inputMode === 'minimal') {
    assert.equal(value, STUBBED_RESULT, `${label}: expected a minimal-mode size marker`);
  } else {
    assert.match(value, /^x{500}… \[\+3500 chars pruned\]$/, `${label}: expected a truncate-mode cut`);
  }
}

async function pruneExemptFixture(inputMode) {
  const { pruneSessionToNewId } = await import('../src/sessionPrune.js');
  const { dir, sid } = await seed(exemptScenario());
  const { newSessionId, saved } = await pruneSessionToNewId({
    cwd: CWD, sessionId: sid, cutTurnIndex: 1, pruneThinking: true, inputMode,
  });
  const byUuid = Object.fromEntries((await readOut(dir, newSessionId)).map(o => [o.uuid, o]));
  const use = (tag) => byUuid[`a_${tag}`].message.content[0];
  const result = (tag) => byUuid[`r_${tag}`].message.content[0].content;
  // The fixture must never be vacuously all-exempt: something real is pruned in
  // every run, on both axes.
  assert.ok(saved.toolInputs > 0 && saved.toolOutputs > 0,
    `nothing was pruned at all (${inputMode}) — the fixture proves nothing: ${JSON.stringify(saved)}`);
  return { use, result, saved };
}

test('prune copies an AskUserQuestion tool_use verbatim', async () => {
  // The question card is rebuilt from input.questions on replay, and the answer
  // is recovered by string-matching the question text + option labels against the
  // following user echo. Squeeze either and the human is left with an unreadable
  // question and no answer on the card.
  for (const inputMode of ['truncate', 'minimal']) {
    await withStore(async () => {
      const { use } = await pruneExemptFixture(inputMode);
      const q = use('uq').input.questions[0];
      assert.equal(q.question, LONG_Q, `question text was squeezed (${inputMode})`);
      assert.equal(q.header, 'Approach');
      assert.equal(q.options[0].label, 'Rewrite');
      assert.equal(q.options[0].description, LONG_DESC, `option description was squeezed (${inputMode})`);
      assert.equal(q.options[1].description, LONG_DESC);
    });
  }
});

test('prune copies an AskUserQuestion tool_result verbatim', async () => {
  // Reached via the tool_use_id → name map, so this fails independently of the
  // tool_use guard above.
  for (const inputMode of ['truncate', 'minimal']) {
    await withStore(async () => {
      const { result } = await pruneExemptFixture(inputMode);
      assert.equal(result('uq'), bigText, `AskUserQuestion result was stubbed (${inputMode})`);
    });
  }
});

test('prune copies core conductor MCP calls verbatim', async () => {
  // The orchestration record. Exempt as a NAMESPACE, so `spawn_instance` — whose
  // own name contains an underscore — must not be mistaken for a plugin call.
  for (const inputMode of ['truncate', 'minimal']) {
    await withStore(async () => {
      const { use, result } = await pruneExemptFixture(inputMode);
      assert.equal(use('core').input.prompt, bigText, `core tool_use squeezed (${inputMode})`);
      assert.equal(use('core').input.project, 'demo');
      assert.equal(result('core'), bigText, `core tool_result stubbed (${inputMode})`);
    });
  }
});

test('prune stubs a plugin-namespaced call while the same-tail core call survives', async () => {
  // THE naive-startsWith catcher. `mcp__code-conductor__code-kanban__file_task`
  // and `mcp__code-conductor__file_task` share a prefix AND a tail; only the
  // segment count separates them, and both are pruned in the SAME run.
  for (const inputMode of ['truncate', 'minimal']) {
    await withStore(async () => {
      const { use, result } = await pruneExemptFixture(inputMode);
      assertStubbedInput(use('plug').input.description, inputMode, `plugin tool_use (${inputMode})`);
      assert.equal(result('plug'), STUBBED_RESULT, `plugin tool_result survived (${inputMode})`);
      assert.equal(use('tail').input.description, bigText, `core tool_use squeezed (${inputMode})`);
      assert.equal(result('tail'), bigText, `core tool_result stubbed (${inputMode})`);
      // A third-party plugin id — no `code-` in it. Pins the discriminator as
      // the `__` segment itself, not the first-party `code-*` naming habit.
      assertStubbedInput(use('thirdparty').input.script, inputMode, `third-party plugin tool_use (${inputMode})`);
      assert.equal(result('thirdparty'), STUBBED_RESULT, `third-party plugin tool_result survived (${inputMode})`);
    });
  }
});

test('prune stubs project_read and project_bash despite the core namespace', async () => {
  // The deliberate carve-outs: bulk file / command output is exactly what Prune
  // exists to shed. Fails the moment PRUNABLE_CONDUCTOR_MCP_TOOLS stops applying.
  for (const inputMode of ['truncate', 'minimal']) {
    await withStore(async () => {
      const { use, result } = await pruneExemptFixture(inputMode);
      assertStubbedInput(use('read').input.pattern, inputMode, `project_read input (${inputMode})`);
      assert.equal(use('read').input.path, 'src/a.js', 'short scalars still pass through');
      assert.equal(result('read'), STUBBED_RESULT, `project_read result survived (${inputMode})`);
      assertStubbedInput(use('bash').input.command, inputMode, `project_bash input (${inputMode})`);
      assert.equal(result('bash'), STUBBED_RESULT, `project_bash result survived (${inputMode})`);
    });
  }
});

test('prune stubs a foreign MCP server unchanged', async () => {
  // The exemption is anchored to `mcp__code-conductor__`, not to `mcp__`.
  for (const inputMode of ['truncate', 'minimal']) {
    await withStore(async () => {
      const { use, result } = await pruneExemptFixture(inputMode);
      assertStubbedInput(use('other').input.payload, inputMode, `foreign tool_use (${inputMode})`);
      assert.equal(result('other'), STUBBED_RESULT, `foreign tool_result survived (${inputMode})`);
    });
  }
});

test('the savings preview accounts for the exemption too', async () => {
  // The exemption must live in the shared pruneBlock, not in the transform loop:
  // bolted onto one side, the dialog would promise savings the rewrite never
  // delivers. Exempt blocks still count toward the per-turn DENOMINATOR — they
  // remain in the model's context.
  await withStore(async () => {
    const { analyzeSessionForPrune, pruneSessionToNewId } = await import('../src/sessionPrune.js');
    const { sid } = await seed(exemptScenario());
    const analysis = await analyzeSessionForPrune({ cwd: CWD, sessionId: sid });

    for (const inputMode of ['truncate', 'minimal']) {
      for (let cut = 0; cut <= analysis.turnCount - 1; cut++) {
        const { saved } = await pruneSessionToNewId({
          cwd: CWD, sessionId: sid, cutTurnIndex: cut, pruneThinking: false, inputMode,
        });
        const prefix = analysis.turns.slice(0, cut);
        assert.deepEqual(saved, {
          thinking: 0,
          toolInputs: prefix.reduce((a, t) => a + (inputMode === 'minimal' ? t.toolInputMinimal : t.toolInputTruncatable), 0),
          toolOutputs: prefix.reduce((a, t) => a + t.toolOutput, 0),
        }, `preview drifted from the transform (cut=${cut}, ${inputMode})`);
      }
    }
    const t0 = analysis.turns[0];
    assert.ok(t0.total > t0.toolOutput + t0.toolInputMinimal,
      'exempt blocks must stay in the denominator — they are still in context');
  });
});

test('isPruneExemptTool draws the line at the segment boundary', async () => {
  const { isPruneExemptTool, PRUNABLE_CONDUCTOR_MCP_TOOLS } = await import('../src/sessionPrune.js');
  for (const name of [
    'AskUserQuestion',
    'mcp__code-conductor__spawn_instance',
    'mcp__code-conductor__merge_worktree',
    'mcp__code-conductor__some_future_tool',
  ]) assert.equal(isPruneExemptTool(name), true, `${name} should be exempt`);
  for (const name of [
    'mcp__code-conductor__project_read',
    'mcp__code-conductor__project_bash',
    'mcp__code-conductor__code-kanban__file_task',
    'mcp__code-conductor__code-hub__start_app',
    // Third-party plugin ids: no `code-` prefix, so these pin the `__` segment
    // as the discriminator rather than the first-party naming convention.
    'mcp__code-conductor__acme-tools__run',
    'mcp__code-conductor__zzz__go',
    'mcp__code-conductor__',
    'mcp__otherserver__do_thing',
    'Read', 'Bash', '', undefined, null,
  ]) assert.equal(isPruneExemptTool(name), false, `${name} should be prunable`);
  assert.equal(PRUNABLE_CONDUCTOR_MCP_TOOLS.size, 2, 'the denylist is exactly the two bulk-output tools');
});
