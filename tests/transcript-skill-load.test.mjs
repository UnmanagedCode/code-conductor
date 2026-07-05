// Replay parity for the Skill-content-injection correlation: a persisted
// jsonl session where a Skill tool_use is followed by its isSynthetic
// content-injection user line must replay with the same `skillLoad` tag the
// live parser stamps (see attachSkillLoad in src/parser.js) — otherwise the
// dedicated skill-loading bubble would only appear live and regress to a
// giant plain-text bubble on session reload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../src/projects.js';
import { loadPersistedTranscript } from '../src/transcript.js';

const CWD = '/tmp/skill-load-project';
const SID = 'sess-skill-load';

function skillSessionLines() {
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'what are the default keybindings?' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_skill', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'keybindings-help', args: 'what are the default keybindings?' } }],
      },
    },
    {
      type: 'user', uuid: 'u1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_skill', content: 'Launching skill: keybindings-help' }] },
    },
    {
      type: 'user', uuid: 'u2', isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nfull reference text here' }] },
    },
    { type: 'assistant', uuid: 'a1', message: { id: 'm_reply', role: 'assistant', content: [{ type: 'text', text: 'Here they are.' }] } },
  ];
}

async function seedTranscript(lines) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-skill-load-'));
  process.env.CLAUDE_PROJECTS_ROOT = rootDir;
  const file = path.join(rootDir, encodeCwd(CWD), `${SID}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return rootDir;
}

function flatEvents(result) {
  const out = [];
  for (const line of result.lines) for (const ev of line.events) out.push(ev);
  return out;
}

test('loadPersistedTranscript: isSynthetic content-injection line correlates with the preceding Skill tool_use', async () => {
  await seedTranscript(skillSessionLines());
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  assert.ok(result, 'transcript loaded');
  const events = flatEvents(result);

  const toolUse = events.find(ev => ev.kind === 'tool_use' && ev.name === 'Skill');
  assert.ok(toolUse, 'Skill tool_use replayed');

  const echoes = events.filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 2, 'the real prompt and the content-injection line each produce a user_echo');
  assert.equal(echoes[0].skillLoad, undefined, 'the real user prompt is not tagged as a skill load');
  assert.deepEqual(echoes[1].skillLoad, { skill: 'keybindings-help' });

  // The intervening tool_result stays a plain, unrelated event.
  const toolResult = events.find(ev => ev.kind === 'tool_result');
  assert.ok(toolResult);
  assert.equal(toolResult.toolUseId, 'tu_skill');
});
