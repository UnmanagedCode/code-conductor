// get_recent_messages marks a message `promptedBy:"human"` when the latest outer
// prompt before it was the human's; any other prompt resets it, and only
// `"human"` is ever emitted. Ring and disk agree, since both feed the same
// reconstruction.
//
// See ./promptAuthorCase.mjs for the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitFor, instForSession, driveTurn, seedSessionJsonl } from './helpers.mjs';
import { setupIdleWake, callTool, unwrap } from './idleWakeCase.mjs';
import { localPlace } from '../src/projects.ts';
import {
  createProject, spawnConductor, spawnWorker, wsPrompt, stdinUserLines,
} from './promptAuthorCase.mjs';

let instances;
setupIdleWake(c => { ({ instances } = c); });
let seq = 0;
const stdinFile = () => path.join(process.env.PROJECTS_ROOT, '..', `stdin-${++seq}.jsonl`);

const promptedBy = async (sid) => unwrap(await callTool('get_recent_messages', { sessionId: sid, count: 3 }))
  .messages.map(m => m.promptedBy ?? null);

// W through a conductor turn, a human turn and a conductor turn.
async function threeTurns() {
  await createProject('p');
  const c = await spawnConductor('p');
  const wFile = stdinFile();
  const w = await spawnWorker('p', c, wFile);
  await driveTurn(instances, w, () => callTool('send_prompt', { sessionId: w, text: 'brief one' }, { caller: c }));
  await driveTurn(instances, w, () => wsPrompt(w, 'the human steps in'));
  await driveTurn(instances, w, () => callTool('send_prompt', { sessionId: w, text: 'brief two' }, { caller: c }));
  return { c, w, wFile };
}

test('live ring: only the human turn\'s message is promptedBy human', async () => {
  const { w } = await threeTurns();
  assert.deepEqual(await promptedBy(w), [null, 'human', null]);
});

test('retired, from disk: only the human turn\'s message is promptedBy human', async () => {
  const { c, w, wFile } = await threeTurns();
  // The fake CLI persists nothing: rebuild the transcript the real CLI would
  // write — each user line as cc sent it, then the assistant reply.
  const inst = instForSession(instances, w);
  const records = [];
  for (const [i, line] of (await stdinUserLines(wFile)).entries()) {
    records.push({ ...line, uuid: `u${i}` });
    records.push({ type: 'assistant', uuid: `a${i}`, message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] } });
  }
  await seedSessionJsonl(localPlace(inst.cwd), inst.backingSessionId, records);
  const killed = unwrap(await callTool('kill_instance', { sessionId: w }, { caller: c }));
  assert.notEqual(killed.ok, false, JSON.stringify(killed));
  await waitFor(() => instances.idsForSession(w).length === 0);
  const r = unwrap(await callTool('get_recent_messages', { sessionId: w, count: 3 }));
  assert.equal(r.source, 'disk');
  assert.deepEqual(r.messages.map(m => m.promptedBy ?? null), [null, 'human', null]);
});
