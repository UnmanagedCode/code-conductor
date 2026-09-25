// The Prune savings ESTIMATE (src/sessionPrune.ts): the per-kind token ratios,
// the per-session calibration against recorded usage, encrypted-thinking sizing,
// compaction, and the exempt readout. The transform's structural invariants live
// in tests/prune-transform.test.mjs.
//
// tests/fixtures/prune-real-opus5.jsonl.gz is a real Opus 5 session: its usage
// fields and ids are verbatim, every other string had its letters and digits
// replaced one-for-one, so every length (and so every estimate) is unchanged.
// Its recorded prune — cut 2 of 3 turns, truncate mode, thinking on — dropped the
// API-measured prompt by REAL_SAVING: the last pre-prune call's prompt plus its
// output, minus the first post-prune call's prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { localPlace } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'prune-real-opus5.jsonl.gz');
const REAL_SAVING = 68431;

const CWD = '/tmp/prune-estimate-project';
const SID = '11111111-2222-3333-4444-666666666666';

async function withStore(fn) {
  const root = await mkdtemp('prune-estimate-');
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = root;
  try { return await fn(root); }
  finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
  }
}

async function seedText(text) {
  const { encodeCwd, claudeProjectsRoot } = await import('../src/projects.ts');
  const dir = path.join(claudeProjectsRoot(), encodeCwd(CWD));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), text);
  return { dir, sid: SID };
}
const seed = (lines) => seedText(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
const seedFixture = async () => seedText(gunzipSync(await fs.readFile(FIXTURE)).toString('utf8'));

async function analyze(sid = SID) {
  const { analyzeSessionForPrune } = await import('../src/sessionPrune.ts');
  return analyzeSessionForPrune({ place: localPlace(CWD), sessionId: sid });
}
async function prune(opts) {
  const { pruneSessionToNewId } = await import('../src/sessionPrune.ts');
  return pruneSessionToNewId({ place: localPlace(CWD), sessionId: SID, mode: 'bypassPermissions', ...opts });
}
async function readOut(dir, sid) {
  const text = await fs.readFile(path.join(dir, `${sid}.jsonl`), 'utf8');
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}
const sumSaved = (s) => s.thinking + s.toolInputs + s.toolOutputs;
const prompt = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResult = (uuid, id, content) => ({
  type: 'user', uuid, toolUseResult: 'ok',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});

// ── the real session ───────────────────────────────────────────────────────

test('the calibrated saving tracks the API-measured drop on a real session', async () => {
  await withStore(async () => {
    await seedFixture();
    const { saved } = await prune({ cutTurnIndex: 2, pruneThinking: true, inputMode: 'truncate' });
    const ratio = sumSaved(saved) / REAL_SAVING;
    assert.ok(ratio >= 0.90 && ratio <= 1.20,
      `calibrated saving is ${(ratio * 100).toFixed(1)}% of the real drop (${JSON.stringify(saved)})`);
  });
});

test('the per-kind ratios alone are right before calibration', async () => {
  // Pins that the calibration factor is not what carries the tool-output ratio:
  // the raw per-turn figures must already land on the real drop.
  await withStore(async () => {
    await seedFixture();
    const a = await analyze();
    assert.equal(a.turnCount, 3);
    const raw = a.turns.slice(0, 2).reduce((s, t) => s + t.toolOutput + t.toolInputTruncatable, 0);
    const ratio = raw / REAL_SAVING;
    assert.ok(ratio >= 0.90 && ratio <= 1.10, `raw estimate is ${(ratio * 100).toFixed(1)}% of the real drop (${raw})`);
  });
});

test('calibration is drawn from the session\'s real usage', async () => {
  await withStore(async () => {
    await seedFixture();
    const { calibration } = await analyze();
    assert.ok(calibration.steps >= 40, `only ${calibration.steps} usable steps`);
    assert.ok(calibration.factor >= 1.0 && calibration.factor <= 1.2, `factor ${calibration.factor}`);
    assert.equal(calibration.calibrated, true);
  });
});

// ── calibration on crafted usage ───────────────────────────────────────────

// One "call" per step: the assistant message that carries a usage reading, split
// across two lines sharing its id and usage the way the CLI writes it. A step
// runs from one call's first line to the next call's.
const CALL_TEXT = 't'.repeat(400);
const RESULT_TEXT = 'r'.repeat(2500);
function callLines(i, promptTokens, { head = [{ type: 'text', text: CALL_TEXT }] } = {}) {
  const message = (content) => ({
    id: `m${i}`, role: 'assistant', model: 'claude-opus-5', content,
    usage: { input_tokens: 5, cache_read_input_tokens: promptTokens - 5, cache_creation_input_tokens: 0, output_tokens: 40 },
  });
  return [
    { type: 'assistant', uuid: `a${i}`, message: message(head) },
    { type: 'assistant', uuid: `b${i}`, message: message([
      { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } },
    ]) },
  ];
}

// The raw estimate of one clean step: the call's text + tool_use and the
// tool_result answering it.
async function cleanStepEstimate(i) {
  const { TOKEN_CHARS } = await import('../src/sessionPrune.ts');
  return Math.ceil(CALL_TEXT.length / TOKEN_CHARS.text)
    + Math.ceil(('Bash' + JSON.stringify({ command: `echo ${i}` })).length / TOKEN_CHARS.toolUse)
    + Math.ceil(RESULT_TEXT.length / TOKEN_CHARS.toolResult);
}

// steps: [{ ratio | delta, head?, extra? }] — `extra` lines ride the step after
// its tool_result; `delta` overrides the ratio × estimate prompt growth.
async function calibrationSession(steps) {
  const lines = [prompt('p0', 'go')];
  let promptTokens = 20000;
  let sumDelta = 0; let sumEst = 0;
  for (const [i, s] of steps.entries()) {
    lines.push(...callLines(i, promptTokens, s.head ? { head: s.head } : {}));
    lines.push(s.result ?? toolResult(`r${i}`, `t${i}`, RESULT_TEXT));
    lines.push(...(s.extra ?? []));
    const est = await cleanStepEstimate(i);
    const delta = s.delta ?? Math.round(est * s.ratio);
    if (!s.polluted) { sumDelta += delta; sumEst += est; }
    promptTokens += delta;
  }
  lines.push(...callLines(steps.length, promptTokens));
  return { lines, cleanFactor: sumDelta / sumEst };
}

const CLEAN = 6;
const cleanSteps = () => Array.from({ length: CLEAN }, () => ({ ratio: 1.5 }));
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1200) } };

test('unmeasured content is excluded from both sides of the calibration', async (t) => {
  // Each polluted step carries a prompt growth wildly off its estimate; if it
  // were used the factor would move and the step count would include it.
  const polluted = {
    'an image block': { result: { type: 'user', uuid: 'rp', toolUseResult: 'ok', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tp', content: RESULT_TEXT }, IMAGE,
    ] } } },
    'an image nested in a tool_result': { result: { type: 'user', uuid: 'rp', toolUseResult: 'ok', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tp', content: [{ type: 'text', text: RESULT_TEXT }, IMAGE] },
    ] } } },
    'a redacted_thinking block': { head: [{ type: 'redacted_thinking', data: 'R'.repeat(2000) }, { type: 'text', text: CALL_TEXT }] },
    'a prune stub': { result: toolResult('rp', 'tp', '[pruned: 3.9 KB]') },
    'the stub of a tool_result that held images': { result: toolResult('rp', 'tp', '[pruned: 3.9 KB; image/png 210×140 (200 B)]') },
    'the stub of a pasted image': { result: { type: 'user', uuid: 'rp', toolUseResult: 'ok', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tp', content: RESULT_TEXT }, { type: 'text', text: '[pruned: image/png 1280×800 (51.2 KB)]' },
    ] } } },
    'the stub of an image with no readable size': { result: toolResult('rp', 'tp', '[pruned: image (url)]') },
    'a non-per-step attachment': { extra: [{ type: 'attachment', uuid: 'at',
      attachment: { type: 'edited_text_file', filename: '/x.ts', snippet: 's'.repeat(3000) } }] },
  };
  for (const [label, pollution] of Object.entries(polluted)) {
    await t.test(label, async () => {
      await withStore(async () => {
        const steps = cleanSteps();
        steps.splice(3, 0, { ...pollution, delta: 60000, polluted: true });
        const { lines, cleanFactor } = await calibrationSession(steps);
        await seed(lines);
        const { calibration } = await analyze();
        assert.equal(calibration.steps, CLEAN, `the step with ${label} was used`);
        assert.ok(Math.abs(calibration.factor - cleanFactor) < 1e-9, `factor ${calibration.factor} ≠ ${cleanFactor}`);
      });
    });
  }
  await t.test('a non-positive prompt delta', async () => {
    await withStore(async () => {
      const steps = cleanSteps();
      steps.splice(3, 0, { delta: -3000, polluted: true });
      const { lines, cleanFactor } = await calibrationSession(steps);
      await seed(lines);
      const { calibration } = await analyze();
      assert.equal(calibration.steps, CLEAN);
      assert.ok(Math.abs(calibration.factor - cleanFactor) < 1e-9, `factor ${calibration.factor} ≠ ${cleanFactor}`);
    });
  });
  await t.test('control: per-step attachments leave a step usable', async () => {
    await withStore(async () => {
      const steps = cleanSteps();
      steps.splice(3, 0, { ratio: 1.5, extra: [
        { type: 'attachment', uuid: 'tr', attachment: { type: 'total_tokens_reminder', total: 1 } },
        { type: 'attachment', uuid: 'hs', attachment: { type: 'hook_success', hookName: 'PostToolUse:Bash', stdout: '' } },
      ] });
      const { lines, cleanFactor } = await calibrationSession(steps);
      await seed(lines);
      const { calibration } = await analyze();
      assert.equal(calibration.steps, CLEAN + 1, 'a step with only per-step attachments must count');
      assert.ok(Math.abs(calibration.factor - cleanFactor) < 1e-9);
    });
  });
});

test('thin history falls back to 1 and absurd history is bounded', async (t) => {
  await t.test('under the minimum estimate: factor 1, uncalibrated, steps still reported', async () => {
    await withStore(async () => {
      const { lines } = await calibrationSession([{ ratio: 1.5 }, { ratio: 1.5 }]);
      await seed(lines);
      assert.deepEqual((await analyze()).calibration, { factor: 1, steps: 2, calibrated: false });
    });
  });
  await t.test('growth far above the estimate clamps to the upper bound', async () => {
    await withStore(async () => {
      const { lines } = await calibrationSession(Array.from({ length: CLEAN }, () => ({ ratio: 10 })));
      await seed(lines);
      assert.deepEqual((await analyze()).calibration, { factor: 2, steps: CLEAN, calibrated: true },
        'a clamped factor is still a calibrated one');
    });
  });
  await t.test('growth far below the estimate clamps to the lower bound', async () => {
    await withStore(async () => {
      const { lines } = await calibrationSession(Array.from({ length: CLEAN }, () => ({ ratio: 0.1 })));
      await seed(lines);
      assert.deepEqual((await analyze()).calibration, { factor: 0.5, steps: CLEAN, calibrated: true },
        'a clamped factor is still a calibrated one');
    });
  });
});

// ── thinking ───────────────────────────────────────────────────────────────

const thinkingSession = (block) => [
  prompt('p0', 'go'),
  { type: 'assistant', uuid: 'a0', message: { id: 'm0', role: 'assistant', content: [block, { type: 'text', text: 'ok' }] } },
  prompt('p1', 'next'),
];

test('encrypted thinking is sized from its signature', async (t) => {
  // Real (signature length → thinking_tokens) pairs from Sonnet 5 / Opus 5 messages.
  for (const [sigLen, thinkingTokens] of [[1596, 317], [1276, 249]]) {
    await t.test(`signature ${sigLen} chars ≈ ${thinkingTokens} tokens`, async () => {
      await withStore(async () => {
        await seed(thinkingSession({ type: 'thinking', thinking: '', signature: 'S'.repeat(sigLen) }));
        const { encryptedThinking } = await analyze();
        assert.ok(Math.abs(encryptedThinking - thinkingTokens) <= thinkingTokens * 0.1,
          `sized ${encryptedThinking}, recorded ${thinkingTokens}`);
      });
    });
  }
  await t.test('visible thinking costs its text, whatever the signature', async () => {
    const { TOKEN_CHARS } = await import('../src/sessionPrune.ts');
    const saved = [];
    for (const sigLen of [10, 5000]) {
      await withStore(async () => {
        await seed(thinkingSession({ type: 'thinking', thinking: 'y'.repeat(4000), signature: 'S'.repeat(sigLen) }));
        const a = await analyze();
        assert.equal(a.encryptedThinking, 0, 'visible thinking is not encrypted thinking');
        saved.push(a.turns[0].thinking);
      });
    }
    assert.deepEqual(saved, Array(2).fill(
      Math.ceil(4000 / TOKEN_CHARS.text) - Math.ceil('[pruned: thinking]'.length / TOKEN_CHARS.text)));
  });
});

test('encrypted thinking is never rewritten, even though it has a cost', async () => {
  // A signature this long is sized well above the thinking stub's own cost (see
  // the signature-sizing test), so without the explicit guard the transform
  // would score a saving and write the stub next to the kept signature.
  await withStore(async () => {
    const block = { type: 'thinking', thinking: '', signature: 'S'.repeat(2000) };
    const lines = thinkingSession(block);
    const { dir } = await seed(lines);
    const a = await analyze();
    assert.ok(a.turns.every(t => t.thinking === 0), 'no thinking saving is offered for it');
    const { newSessionId, saved } = await prune({ cutTurnIndex: 2, pruneThinking: true, inputMode: 'minimal' });
    assert.equal(saved.thinking, 0);
    const out = Object.fromEntries((await readOut(dir, newSessionId)).map(o => [o.uuid, o]));
    assert.deepEqual(out.a0.message.content, lines[1].message.content, 'encrypted thinking copied verbatim');
  });
});

// ── compaction ─────────────────────────────────────────────────────────────

test('content before the last compaction counts nowhere and is copied verbatim', async () => {
  await withStore(async () => {
    const usage = (p) => ({ input_tokens: p, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 });
    const beforeCompaction = [
      prompt('p0', 'first'),
      { type: 'assistant', uuid: 'a0', message: { id: 'm0', role: 'assistant', model: 'claude-opus-5', usage: usage(10000), content: [
        { type: 'thinking', thinking: 'y'.repeat(4000), signature: 's' },
        { type: 'thinking', thinking: '', signature: 'S'.repeat(3000) },
        { type: 'tool_use', id: 't0', name: 'Bash', input: { command: 'c'.repeat(4000) } },
      ] } },
      toolResult('r0', 't0', 'o'.repeat(8000)),
      { type: 'assistant', uuid: 'a0b', message: { id: 'm0b', role: 'assistant', model: 'claude-opus-5', usage: usage(16000), content: [
        { type: 'text', text: 'read it' },
      ] } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb0' },
      prompt('p1', 'second'),
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'd'.repeat(4000) } },
      ] } },
      toolResult('r1', 't1', 'o'.repeat(8000)),
    ];
    const afterCompaction = [
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb1' },
      prompt('p2', 'third'),
      { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x.ts' } },
      ] } },
      toolResult('r2', 't2', 'q'.repeat(2000)),
      prompt('p3', 'fourth'),
    ];
    const lines = [...beforeCompaction, ...afterCompaction];
    const { dir } = await seed(lines);
    const a = await analyze();
    assert.equal(a.turnCount, 4);
    for (const i of [0, 1]) {
      const t = a.turns[i];
      assert.deepEqual([t.thinking, t.toolInputTruncatable, t.toolInputMinimal, t.toolOutput, t.exempt, t.total],
        [0, 0, 0, 0, 0, 0], `turn ${i} is before the last compaction`);
    }
    assert.equal(a.turns.reduce((s, t) => s + t.thinking, 0), 0, 'pre-compaction thinking offers no saving');
    assert.equal(a.encryptedThinking, 0, 'pre-compaction encrypted thinking is not in context');
    assert.deepEqual(a.calibration, { factor: 1, steps: 0, calibrated: false }, 'pre-compaction usage is not a calibration step');
    assert.ok(a.turns[2].toolOutput > 0, 'the post-compaction output is counted');

    for (const inputMode of ['truncate', 'minimal']) {
      for (let cut = 0; cut <= a.turnCount; cut++) {
        const { newSessionId, saved } = await prune({ cutTurnIndex: cut, pruneThinking: true, inputMode });
        const out = Object.fromEntries((await readOut(dir, newSessionId)).map(o => [o.uuid, o]));
        for (const line of beforeCompaction) {
          assert.deepEqual(out[line.uuid].message?.content, line.message?.content,
            `${line.uuid} rewritten (cut=${cut}, ${inputMode})`);
        }
        const prefix = a.turns.slice(0, cut);
        assert.deepEqual(saved, {
          thinking: 0,
          toolInputs: prefix.reduce((s, t) => s + (inputMode === 'minimal' ? t.toolInputMinimal : t.toolInputTruncatable), 0),
          toolOutputs: prefix.reduce((s, t) => s + t.toolOutput, 0),
        }, `preview drifted from the transform (cut=${cut}, ${inputMode})`);
      }
    }
  });
});

// ── exempt ─────────────────────────────────────────────────────────────────

test('an exempt tool\'s payload is reported as kept, not saved', async () => {
  await withStore(async () => {
    const { TOKEN_CHARS } = await import('../src/sessionPrune.ts');
    const name = 'mcp__code-conductor__spawn_instance';
    const input = { project: 'p', prompt: 'p'.repeat(4000) };
    await seed([
      prompt('p0', 'go'),
      { type: 'assistant', uuid: 'a0', message: { id: 'm0', role: 'assistant', content: [
        { type: 'tool_use', id: 't0', name, input },
      ] } },
      toolResult('r0', 't0', 'r'.repeat(4000)),
      prompt('p1', 'next'),
    ]);
    const a = await analyze();
    assert.equal(a.turns[0].exempt,
      Math.ceil((name + JSON.stringify(input)).length / TOKEN_CHARS.toolUse) + Math.ceil(4000 / TOKEN_CHARS.toolResult));
    assert.equal(a.turns[0].toolOutput, 0);
    assert.equal(a.turns[0].toolInputTruncatable, 0);
    assert.equal(a.turns[1].exempt, 0);
  });
});
