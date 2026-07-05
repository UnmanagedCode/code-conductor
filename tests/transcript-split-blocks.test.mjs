// Disk-replay of the async-worker CLI's fragmented persistence shape: one
// logical assistant message written as N single-block `type:"assistant"`
// jsonl lines sharing message.id (observed in real sessions, e.g. two
// thinking lines then tool_use lines, with the tool_result user line
// sandwiched mid-message). Replay must assign each block of a msgId a
// distinct, monotonically increasing blockIdx — matching the live stream's
// content_block_start indices — or same-type blocks collide on the UI's
// `${msgId}:${blockIdx}:${type}` dedup key and render merged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { encodeCwd } from '../src/projects.js';
import { loadPersistedTranscript, loadSubAgentTranscript } from '../src/transcript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CWD = '/tmp/split-blocks-project';
const SID = 'sess-split-blocks';

// Real observed shape (conductor session, CLI 2.1.158): thinking, thinking,
// tool_use, tool_use — four single-block lines, one msgId, with the first
// tool_result user line landing between the two tool_use lines.
function splitBlockLines() {
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do the work' } },
    { type: 'assistant', uuid: 'a0', message: { id: 'm_frag', role: 'assistant', content: [{ type: 'thinking', thinking: 'first thought' }] } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm_frag', role: 'assistant', content: [{ type: 'thinking', thinking: 'second thought' }] } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm_frag', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } }] } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'aaa', is_error: false }] } },
    { type: 'assistant', uuid: 'a3', message: { id: 'm_frag', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_b', name: 'Read', input: { file_path: '/b' } }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_b', content: 'bbb', is_error: false }] } },
    // A separate message afterwards — its indices must restart at 0.
    { type: 'assistant', uuid: 'a4', message: { id: 'm_next', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
}

async function seedTranscript(lines, relPath) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-split-blocks-'));
  process.env.CLAUDE_PROJECTS_ROOT = rootDir;
  const file = path.join(rootDir, encodeCwd(CWD), relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return rootDir;
}

function flatEvents(result) {
  const out = [];
  for (const line of result.lines) for (const ev of line.events) out.push(ev);
  return out;
}

test('loadPersistedTranscript: blocks of a fragmented msgId replay with distinct, monotonic blockIdx', async () => {
  await seedTranscript(splitBlockLines(), `${SID}.jsonl`);
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  assert.ok(result, 'transcript loaded');
  const events = flatEvents(result);

  const fragIdx = (kind) => events
    .filter(ev => ev.msgId === 'm_frag' && ev.kind === kind)
    .map(ev => ev.blockIdx);
  assert.deepEqual(fragIdx('thinking_start'), [0, 1],
    'two thinking blocks persisted as separate single-block lines must not collide on blockIdx');
  assert.deepEqual(fragIdx('tool_use'), [2, 3],
    'tool_use blocks continue the same per-msgId index sequence');

  // Per-block deltas stay attached to their own index.
  const thinkDeltas = events.filter(ev => ev.msgId === 'm_frag' && ev.kind === 'thinking_delta');
  assert.deepEqual(thinkDeltas.map(ev => [ev.blockIdx, ev.text]),
    [[0, 'first thought'], [1, 'second thought']]);

  // A different message restarts at 0.
  const next = events.find(ev => ev.msgId === 'm_next' && ev.kind === 'text_delta');
  assert.equal(next.blockIdx, 0, 'block indices are per-msgId, not global');
});

test('loadSubAgentTranscript: fragmented sub-agent messages get the same per-msgId indices', async () => {
  const agentId = 'a0ffee';
  await seedTranscript(splitBlockLines(), path.join(SID, 'subagents', `agent-${agentId}.jsonl`));
  const events = await loadSubAgentTranscript({
    cwd: CWD, sessionId: SID, agentId, parentToolUseId: 'tu_outer',
  });
  const thinkStarts = events.filter(ev => ev.msgId === 'm_frag' && ev.kind === 'thinking_start');
  assert.deepEqual(thinkStarts.map(ev => ev.blockIdx), [0, 1]);
  assert.ok(events.every(ev => ev.parentToolUseId === 'tu_outer'), 'sub-agent events stay tagged');
});

// End-to-end DOM regression for the actual misrender: on replay, the second
// thinking block's colliding `${msgId}:0:thinking` key made its deltas append
// into the FIRST ThinkingBlock — one merged block where the live stream
// rendered two.
test('DOM: replayed fragmented message renders two thinking blocks, not one merged block', async () => {
  await seedTranscript(splitBlockLines(), `${SID}.jsonl`);
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  const events = flatEvents(result);

  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  const { Conversation } = await import(
    pathToFileURL(path.resolve(__dirname, '..', 'public', 'conversation.js')).href
  );
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');

  const conversation = new Conversation(root);
  for (const ev of events) conversation.apply(ev);

  const thinkBlocks = [...root.querySelectorAll('.block.thinking')];
  assert.equal(thinkBlocks.length, 2,
    'both persisted thinking blocks must render as distinct blocks after replay');
  const texts = thinkBlocks.map(n => n.querySelector('.body')?.textContent ?? '');
  assert.deepEqual(texts, ['first thought', 'second thought'],
    'each thinking block keeps its own content (no merge into the first block)');
  // The two tool blocks survive as before (toolUseId-keyed, already immune).
  assert.equal(root.querySelectorAll('.block.tool').length, 2, 'both tool blocks render');
  assert.equal(root.querySelectorAll('.block.tool-result').length, 2,
    'each tool_result attaches to its own tool block');
});
