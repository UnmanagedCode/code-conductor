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
  HUMAN_MARK, createProject, spawnConductor, spawnWorker, wsPrompt, stdinUserLines,
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

test('a CLI-injected echo between the human prompt and the reply does not reset promptedBy', async () => {
  await createProject('p');
  const c = await spawnConductor('p');
  const w = await spawnWorker('p', c, stdinFile());
  await driveTurn(instances, w, () => wsPrompt(w, 'the human asks'));
  const inst = instForSession(instances, w);
  const text = (t) => ({ type: 'text', text: t });
  // As the CLI persists it: the human's marked prompt, a line the CLI injected
  // itself (`isMeta`, e.g. hook feedback), then the reply.
  await seedSessionJsonl(localPlace(inst.cwd), inst.backingSessionId, [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: [text('the human asks'), text(HUMAN_MARK)] } },
    { type: 'user', uuid: 'u1', isMeta: true, message: { role: 'user', content: [text('injected by the CLI')] } },
    { type: 'assistant', uuid: 'a0', message: { id: 'm0', role: 'assistant', content: [text('the reply')] } },
  ]);
  const killed = unwrap(await callTool('kill_instance', { sessionId: w }, { caller: c }));
  assert.notEqual(killed.ok, false, JSON.stringify(killed));
  await waitFor(() => instances.idsForSession(w).length === 0);
  const tx = unwrap(await callTool('get_transcript', { sessionId: w }));
  assert.ok(tx.events.some(e => e.kind === 'user_echo' && e.cliInjected), 'precondition: the injected echo replays as cliInjected');
  const r = unwrap(await callTool('get_recent_messages', { sessionId: w, count: 1 }));
  assert.equal(r.source, 'disk');
  assert.equal(r.messages.at(-1).promptedBy, 'human');
});
