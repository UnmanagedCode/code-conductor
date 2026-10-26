// Which send surface writes which author into a CONDUCTED worker: the WS
// `{t:'prompt'}` frame (composer, plan card, question card) writes `human`, every
// conductor MCP send writes `conductor`, and a hand-spawned session gets neither
// — no marker block on its stdin, no `author` on its echo. The marker is
// persisted with the line, so a retired worker's transcript still says who wrote
// each prompt.
//
// See ./promptAuthorCase.mjs for the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitFor, instForSession, driveTurn, seedSessionJsonl, api } from './helpers.mjs';
import { setupIdleWake, callTool, unwrap, ctx } from './idleWakeCase.mjs';
import { localPlace } from '../src/projects.ts';
import { buildApprovePrompt } from '../shared/planApproval.ts';
import { formatUserQuestionAnswers } from '../shared/userQuestionAnswers.ts';
import {
  HUMAN_MARK, CONDUCTOR_MARK, createProject, spawnConductor, spawnWorker, spawnHand,
  wsPrompt, stdinUserLines, textBlocks, lastText, lineWith, echoWith,
} from './promptAuthorCase.mjs';

let instances, home;
setupIdleWake(c => { ({ instances } = c); });
let seq = 0;
const stdinFile = () => path.join(process.env.PROJECTS_ROOT, '..', `stdin-${++seq}.jsonl`);
void home;

// C conducts W; both idle. W's stdin is recorded.
async function conducted() {
  await createProject('p');
  const c = await spawnConductor('p');
  const wFile = stdinFile();
  const w = await spawnWorker('p', c, wFile);
  return { c, w, wFile };
}

// One prompt into `sid` through `send`, waited out to its turn_end.
const turn = (sid, send) => driveTurn(instances, sid, send);

test('a WS prompt into a conducted worker is written human: trailing marker block on stdin, author on the echo', async () => {
  const { w, wFile } = await conducted();
  await turn(w, () => wsPrompt(w, 'human typed this'));
  const line = lineWith(await stdinUserLines(wFile), 'human typed this');
  assert.ok(line, 'the prompt reached the CLI');
  assert.equal(lastText(line), HUMAN_MARK, `blocks: ${JSON.stringify(textBlocks(line))}`);
  assert.equal(textBlocks(line)[0], 'human typed this', 'the prompt text stays the first block');
  assert.equal(echoWith(w, 'human typed this').author, 'human');
  assert.ok(!echoWith(w, 'human typed this').text.includes('[[cc:author'), 'the echo text carries no marker');
});

test('plan-card and question-card answers over the WS frame are human', async () => {
  const { w, wFile } = await conducted();
  const approve = buildApprovePrompt('ship it');
  const answer = formatUserQuestionAnswers(
    [{ question: 'Pick a fruit', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana' }] }],
    [{ kind: 'option', label: 'Apple' }]);
  for (const text of [approve, answer]) {
    await turn(w, () => wsPrompt(w, text));
    const line = (await stdinUserLines(wFile)).find(l => textBlocks(l)[0] === text);
    assert.ok(line, `card text reached the CLI: ${text}`);
    assert.equal(lastText(line), HUMAN_MARK);
    assert.equal(instForSession(instances, w).ringSnapshot()
      .find(ev => ev.kind === 'user_echo' && ev.text === text)?.author, 'human');
  }
});

// One top-level test per tool: the harness's root afterEach also runs around
// subtests, so each row needs its own fixture.
const CONDUCTOR_SENDS = [
  ['send_prompt', 'brief from the conductor', ({ c, w }) => callTool('send_prompt', { sessionId: w, text: 'brief from the conductor' }, { caller: c })],
  ['send_prompt forward', 'relay this output', async ({ c, w }) => {
    const h = await spawnHand('p', stdinFile());
    await turn(h, () => wsPrompt(h, 'give me output to forward'));
    return callTool('send_prompt', { sessionId: w, text: 'relay this output', forward: { sessionId: h } }, { caller: c });
  }],
  ['approve_plan', 'approve-feedback-token', ({ c, w }) => callTool('approve_plan', { sessionId: w, feedback: 'approve-feedback-token' }, { caller: c })],
  ['reject_plan', 'reject-feedback-token', ({ c, w }) => callTool('reject_plan', { sessionId: w, feedback: 'reject-feedback-token' }, { caller: c })],
  ['answer_question', 'Apple', async ({ c, w }) => {
    await turn(w, () => callTool('send_prompt', { sessionId: w, text: 'ASKTURN please' }, { caller: c }));
    return callTool('answer_question', { sessionId: w, answers: [{ option: 'Apple' }] }, { caller: c });
  }],
  ['renew_session request', 'renew', ({ c, w }) => callTool('renew_session', { sessionId: w }, { caller: c })],
];

for (const [name, needle, send] of CONDUCTOR_SENDS) {
  test(`${name} into a conducted worker is written conductor`, async () => {
    const fx = await conducted();
    const wInst = instForSession(instances, fx.w);
    const ends = () => wInst.ringSnapshot().filter(e => e.kind === 'turn_end').length;
    const res = unwrap(await send(fx));
    assert.notEqual(res.ok, false, `${name} refused: ${JSON.stringify(res)}`);
    // The send's own turn, whatever came before it in this row.
    const line = await waitFor(async () => (await stdinUserLines(fx.wFile)).findLast(l =>
      textBlocks(l).some(x => x.toLowerCase().includes(needle.toLowerCase()))));
    const endsAtSend = ends();
    await waitFor(() => wInst.status === 'idle' && ends() >= endsAtSend);
    assert.equal(lastText(line), CONDUCTOR_MARK, `blocks ${JSON.stringify(textBlocks(line))}`);
    const echo = wInst.ringSnapshot().filter(ev => ev.kind === 'user_echo' && ev.text === textBlocks(line)[0]).at(-1);
    assert.equal(echo?.author, 'conductor', 'echo authored conductor');
  });
}

test('one session, both authors: get_transcript returns each echo with its own author', async () => {
  const { c, w } = await conducted();
  await turn(w, () => wsPrompt(w, 'the human asks'));
  await turn(w, () => callTool('send_prompt', { sessionId: w, text: 'the conductor asks' }, { caller: c }));
  const { events } = unwrap(await callTool('get_transcript', { sessionId: w, fromSeq: 0 }));
  const authors = events.filter(e => e.kind === 'user_echo').map(e => [e.text, e.author]);
  assert.deepEqual(authors, [['the human asks', 'human'], ['the conductor asks', 'conductor']]);
});

test('a hand-spawned session gets no marker and no author from either surface', async () => {
  await createProject('p');
  const c = await spawnConductor('p');
  const hFile = stdinFile();
  const h = await spawnHand('p', hFile);
  await turn(h, () => wsPrompt(h, 'human into hand-spawned'));
  await turn(h, () => callTool('send_prompt', { sessionId: h, text: 'conductor into hand-spawned' }, { caller: c }));
  const lines = await stdinUserLines(hFile);
  for (const needle of ['human into hand-spawned', 'conductor into hand-spawned']) {
    const line = lineWith(lines, needle);
    assert.ok(line, `${needle} reached the CLI`);
    assert.deepEqual(textBlocks(line), [needle], 'no marker block');
    assert.equal('author' in echoWith(h, needle), false, 'no author on the echo');
  }
});

test('a retired worker\'s transcript still names each prompt\'s author', async () => {
  const { c, w, wFile } = await conducted();
  await turn(w, () => wsPrompt(w, 'retired human prompt'));
  await turn(w, () => callTool('send_prompt', { sessionId: w, text: 'retired conductor prompt' }, { caller: c }));
  // The fake CLI persists no transcript, so this one is assembled the way the
  // real CLI writes it: each `user` line exactly as cc wrote it to stdin, then
  // an assistant reply.
  const inst = instForSession(instances, w);
  const records = [];
  for (const [i, line] of (await stdinUserLines(wFile)).entries()) {
    records.push({ ...line, uuid: `u${i}` });
    records.push({ type: 'assistant', uuid: `a${i}`, message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] } });
  }
  await seedSessionJsonl(localPlace(inst.cwd), inst.backingSessionId, records);
  const killed = unwrap(await callTool('kill_instance', { sessionId: w }, { caller: c }));
  assert.notEqual(killed.ok, false, `kill_instance refused: ${JSON.stringify(killed)}`);
  await waitFor(() => instances.idsForSession(w).length === 0);

  const page = unwrap(await callTool('get_transcript', { sessionId: w, fromSeq: 0 }));
  assert.equal(page.source, 'disk');
  const authors = page.events.filter(e => e.kind === 'user_echo').map(e => [e.text, e.author]);
  assert.deepEqual(authors, [['retired human prompt', 'human'], ['retired conductor prompt', 'conductor']]);
});

test('the rebase-prompt route into a conducted worker is written human', async () => {
  await createProject('p'); // a git repo with an initial commit
  const c = await spawnConductor('p');
  const wFile = stdinFile();
  const w = await spawnWorker('p', c, wFile, { createWorktree: true });
  const wInst = instForSession(instances, w);
  assert.ok(wInst.worktree, 'precondition: W sits in a worktree');
  const r = await turn(w, () => api(ctx.baseUrl, 'POST', `/api/instances/${wInst.id}/rebase-prompt`));
  assert.equal(r.body?.ok, true, JSON.stringify(r.body));
  const line = (await stdinUserLines(wFile)).at(-1);
  assert.equal(line.message.content.at(-1).text, HUMAN_MARK);
  const echo = wInst.ringSnapshot().filter(e => e.kind === 'user_echo').at(-1);
  assert.match(echo.text, /git rebase --rebase-merges /, 'precondition: the rebase brief');
  assert.equal(echo.author, 'human');
});
