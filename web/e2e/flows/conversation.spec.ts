import { expect, test } from './test.ts';
import { api, createProject } from '../harness/api.ts';
import { bringTo, conceal, cssOf, offsetFromTop, reveal, sendAll, tallPrompt } from './stickyPin.ts';
import { LONG_WAKE_STUB, overflowsX, sendWake, WAKE_PAYLOAD } from './foldedBubbles.ts';
import { appendTranscriptRecord } from '../harness/transcript.ts';
import { answerCard, askCard, expectLockedOn, expectQaAnswerRows, instanceIn, QA_NOTE, reselect } from './questionCard.ts';
import { MID_TURN_NOTE } from '../../../src/instances.ts';
import { AWAITING_INPUT_MESSAGE } from '../../../src/settings.ts';
import { formatUserQuestionAnswers } from '../../../public/userQuestionAnswers.ts';
import { buildWakeStub } from '../../../public/wakeCallback.ts';

test('revealed with Down, the pin holds the prompt being read; a click jumps to it, the held prompt peeks back as the transcript scrolls on, a full-page view keeps it, and Up conceals it', async ({ page, cc, ui, uniq }) => {
  const project = uniq('pin-jump');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendAll(page, ui, [tallPrompt('PIN-ALPHA'), tallPrompt('PIN-BRAVO'), tallPrompt('PIN-CHARLIE')]);
  const transcript = ui.transcript(page);
  const prompts = ui.userMessages(page);
  const pin = ui.pin(page);
  const bravo = prompts.nth(1);

  await expect(prompts).toHaveCount(3);
  await expect(pin).toBeHidden();
  await bringTo(transcript, bravo, -150);
  await reveal(page, ui);
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute('role', 'button');
  await expect(pin).toContainText('PIN-BRAVO');

  await pin.click();
  await expect.poll(async () => Math.abs(await offsetFromTop(transcript, bravo))).toBeLessThanOrEqual(1);
  // "Hidden right after the jump" is pinned in sticky-prompt.spec.ts.
  await bringTo(transcript, bravo, 40);
  await expect(pin).toBeVisible();
  await expect(pin).toContainText('PIN-ALPHA');

  await ui.openSettings(page);
  await expect(pin).toBeHidden();
  await ui.leaveSettings(page);
  await expect(pin).toBeVisible();

  await conceal(page, ui);
  await expect(pin).toBeHidden();
});

test('a status line is a status region with no jump affordance; a pinned prompt is the jump button again', async ({ page, cc, ui, uniq }) => {
  // Invariant: the status line is a status region with no tab stop and no title, whose text tells the reader there is nothing earlier; once a prompt pins, the pin is the focusable, titled jump button.
  const project = uniq('pin-status');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendAll(page, ui, [tallPrompt('PIN-SOLO')]);
  const transcript = ui.transcript(page);
  const pin = ui.pin(page);
  const solo = ui.userMessages(page).nth(0);

  await transcript.evaluate((s) => { s.scrollTop = 0; });
  await reveal(page, ui);
  // The pin reads "none" only once the session's tail probe has settled. Every
  // check below compares that settled state.
  await expect(pin).toContainText(/no earlier prompt/i);
  await expect(pin).not.toContainText(/loading/i);
  await expect(pin).toHaveAttribute('role', 'status');
  await expect(pin).not.toHaveAttribute('tabindex');
  await expect(pin).not.toHaveAttribute('title');

  await bringTo(transcript, solo, -150);
  await expect(pin).toHaveAttribute('role', 'button');
  await expect(pin).toHaveAttribute('tabindex', '0');
  await expect(pin).toHaveAttribute('title', /.+/);
  await expect(pin).toContainText('PIN-SOLO');
});

test('the pin clamps a long prompt and fits a short one, and both swipe zones keep pinch zoom without a vertical pan', async ({ page, cc, ui, uniq }) => {
  // Invariant: a long prompt overflows the pin's clamp while a short one fits it; both swipe zones pan only sideways and keep pinch zoom.
  const project = uniq('pin-clamp');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendAll(page, ui, [tallPrompt('PIN-LONG'), 'PIN-SHORT a short prompt', tallPrompt('PIN-FILLER')]);
  const transcript = ui.transcript(page);
  const prompts = ui.userMessages(page);
  const pin = ui.pin(page);
  const pinBody = ui.pinBody(page);

  for (const z of ui.swipeZones(page)) expect(await cssOf(z, 'touch-action')).toBe('pan-x pinch-zoom');

  await bringTo(transcript, prompts.nth(0), -100);
  await reveal(page, ui);
  await expect(pin).toContainText('PIN-LONG');
  await expect.poll(() => pinBody.evaluate((e) => e.scrollHeight > e.clientHeight + 1), 'the long prompt overflows the clamp').toBe(true);

  await bringTo(transcript, prompts.nth(1), -60);
  await expect(pin).toContainText('PIN-SHORT');
  await expect.poll(() => pinBody.evaluate((e) => e.scrollHeight <= e.clientHeight + 1), 'the short prompt fits the clamp').toBe(true);
});

test('a wake-callback stub renders as a collapsed fold naming its worker that opens to its payload and closes again', async ({ page, cc, ui, uniq }) => {
  // Invariant: the wake stub is a closed fold whose toggle names its worker; its body opens and closes with its toggle.
  const project = uniq('wake-fold');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendWake(page, ui, 1);
  const fold = ui.wakeFold(page);
  const toggle = ui.foldToggle(fold);
  const body = ui.foldBody(fold);

  await expect(body).toBeHidden();
  await expect(toggle).toContainText('finished its turn');
  await expect(toggle).toContainText('wakeparity');

  await toggle.click();
  await expect(body).toBeVisible();
  await expect(body).toContainText('WAKE-PROSE');

  await toggle.click();
  await expect(body).toBeHidden();
  await expect(ui.userMessages(page).first()).not.toContainText('[[cc:');
});

test('an expanded wake body keeps its metadata line apart from its prose, and its raw view across a collapse and reopen', async ({ page, cc, ui, uniq }) => {
  // Invariant: the meta line holds exactly the metadata and the prose renders as markdown without it; the expanded body and its raw view survive a collapse and reopen.
  const project = uniq('wake-raw');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendWake(page, ui, 1);
  const fold = ui.wakeFold(page);
  const toggle = ui.foldToggle(fold);
  await toggle.click();

  const meta = ui.wakeMeta(fold);
  const prose = fold.locator('.md p', { hasText: 'WAKE-PROSE' });
  await expect(meta).toHaveText('{"sessionId":"wakeparity","source":"live"}');
  await expect(prose).toBeVisible();
  await expect(prose).not.toContainText('"sessionId"');

  await ui.toggleFoldView(fold);
  await expect(ui.foldRaw(fold)).toBeVisible();
  expect(await ui.foldRaw(fold).evaluate((e) => e.textContent)).toBe(WAKE_PAYLOAD);
  await toggle.click();
  await expect(ui.foldBody(fold)).toBeHidden();
  await toggle.click();
  await expect(ui.foldRaw(fold)).toBeVisible();
  expect(await ui.foldRaw(fold).evaluate((e) => e.textContent)).toBe(WAKE_PAYLOAD);

  // Invariant: an unbroken meta-line token and an unbroken prose token wrap inside the fold body in both views, so neither the body nor the transcript scrolls sideways.
  await sendWake(page, ui, 2, { stub: LONG_WAKE_STUB, folds: 2 });
  const long = ui.wakeFold(page).nth(1);
  await ui.foldToggle(long).click();
  await expect(ui.wakeMeta(long)).toContainText('"hint":"mmm');
  await expect(long.locator('.md p', { hasText: 'LONGPROSE-' })).toBeVisible();
  expect(await overflowsX(ui.foldBody(long)), 'the rendered fold body overflows sideways').toBe(false);
  expect(await overflowsX(ui.transcript(page)), 'the transcript overflows sideways (rendered)').toBe(false);
  await ui.toggleFoldView(long);
  await expect(ui.foldRaw(long)).toBeVisible();
  expect(await overflowsX(ui.foldBody(long)), 'the raw fold body overflows sideways').toBe(false);
  expect(await overflowsX(ui.foldRaw(long)), 'the raw view overflows sideways').toBe(false);
  expect(await overflowsX(ui.transcript(page)), 'the transcript overflows sideways (raw)').toBe(false);
});

test('markdown headings in a prompt and in a folded wake body are headings, and the prompt raw/copy row shows on touch and on hover', async ({ page, cc, ui, uniq }) => {
  // Invariant: a markdown heading in prompt text and in a fold body is a heading, and the prose around it is not.
  const project = uniq('heads');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendAll(page, ui, ['HEAD-PIN intro paragraph\n\n# HEAD-PIN heading\n\nHEAD-PIN body paragraph']);
  const t = ui.transcript(page);

  await expect(t.getByRole('heading', { name: 'HEAD-PIN heading' })).toBeVisible();
  await expect(t.getByRole('heading', { name: /HEAD-PIN (intro|body) paragraph/ })).toHaveCount(0);

  // Invariant: the prompt bubble's raw/copy row is hidden until hover on a hover device and always shown on a touch device.
  const controls = ui.userControls(ui.userMessages(page).first());
  await expect(controls).toHaveCount(1);
  const touch = await page.evaluate(() => matchMedia('(hover: none)').matches);
  await expect.poll(() => cssOf(controls, 'opacity'), `opacity with (hover: none) = ${touch}`).toBe(touch ? '1' : '0');

  await sendWake(page, ui, 2);
  const fold = ui.wakeFold(page);
  await ui.foldToggle(fold).click();
  await expect(fold.getByRole('heading', { name: /WAKE-HEAD/ })).toBeVisible();
  await expect(fold.getByRole('heading', { name: /WAKE-PROSE/ })).toHaveCount(0);
});

test('a two-question card stays open through a wake stub, locks on its answer with each pane\'s pick and note, keeps its controls disabled through tab clicks, and replays locked with the same answer rows', async ({ page, cc, ui, uniq }) => {
  // Invariant: an interleaved wake stub leaves the card open; the stamped answer locks it with each pane's pick and note; tab clicks never re-open a control; a snapshot replay renders the same locked card and answer rows.
  const project = uniq('qa-live');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  let card = await askCard(page, ui);
  // An open multi-question card reads "0/2 answered": only the anchored form means locked.
  await expect(ui.cardOption(card, 'Apple')).toBeEnabled();
  expect(await ui.cardOptionPicked(ui.cardOption(card, 'Apple'))).toBe(false);
  await expect(ui.cardStatus(card)).not.toHaveText(/^answered$/i);

  await sendWake(page, ui, 2);
  await expect(ui.cardOption(card, 'Apple')).toBeEnabled();
  await expect(ui.cardStatus(card)).not.toHaveText(/^answered$/i);
  await expect(ui.cardSend(card)).toBeDisabled();

  await answerCard(page, ui, card, 3);
  await expectLockedOn(ui, card, 'L', 'S', '');
  await ui.cardTab(card, 0).click();
  await expectLockedOn(ui, card, 'Banana', 'Apple', QA_NOTE);
  await expect(ui.answerBubble(page)).toHaveCount(1);
  await expectQaAnswerRows(ui, ui.answerBubble(page));

  await reselect(page, ui, project, inst.sessionId);
  card = ui.questionCard(page);
  await expect(card).toHaveCount(1);
  await expectLockedOn(ui, card, 'Banana', 'Apple', QA_NOTE);
  await ui.cardTab(card, 1).click();
  await expectLockedOn(ui, card, 'L', 'S', '');
  await expect(ui.answerBubble(page)).toHaveCount(1);
  await expectQaAnswerRows(ui, ui.answerBubble(page));
});

test('a mid-turn answer replayed from disk past an interleaved wake stub locks the card on the answered option, and the mid-turn note never shows', async ({ page, cc, ui, uniq }) => {
  // Invariant: the server's disk replay strips the mid-turn note, stamps the answer past an interleaved wake stub, and the card renders locked on the answered option.
  const project = uniq('qa-replay');
  await createProject(cc, project);
  expect((await api(cc, 'POST', '/api/instances', { project, mode: 'bypassPermissions', temp: false })).status).toBeLessThan(300);
  const inst = await instanceIn(cc, project);
  const Q = [{ question: 'Pick a QA replay fruit', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana' }] }];
  const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
  await appendTranscriptRecord(cc, inst.id, user('QA-REPLAY opening prompt'));
  await appendTranscriptRecord(cc, inst.id, { type: 'assistant', message: { id: 'msg_qr', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_qr', name: 'AskUserQuestion', input: { questions: Q } }], stop_reason: 'tool_use' } });
  await appendTranscriptRecord(cc, inst.id, user([{ type: 'tool_result', tool_use_id: 'toolu_qr', content: AWAITING_INPUT_MESSAGE, is_error: true }]));
  await appendTranscriptRecord(cc, inst.id, user(buildWakeStub({ targetSessionId: 'qareplay', payloadText: '{"sessionId":"qareplay"}\nQA-WAKE prose' })));
  await appendTranscriptRecord(cc, inst.id, user([{ type: 'text', text: MID_TURN_NOTE }, { type: 'text', text: formatUserQuestionAnswers(Q, [{ kind: 'option', label: 'Apple' }]) }]));

  await api(cc, 'DELETE', `/api/instances/${inst.id}`);
  await expect.poll(async () => {
    const x = (await api<{ id: string; status: string }[]>(cc, 'GET', '/api/instances')).body.find((i) => i.id === inst.id);
    return !x || x.status === 'exited';
  }).toBe(true);
  const resumed = await api<{ id: string }>(cc, 'POST', '/api/instances', { project, resume: inst.sessionId, mode: 'bypassPermissions' });
  expect(resumed.status).toBeLessThan(300);
  await expect.poll(async () =>
    (await api<{ id: string; status: string }[]>(cc, 'GET', '/api/instances')).body.find((i) => i.id === resumed.body.id)?.status,
  ).toBe('idle');

  await ui.open(page);
  const row = await ui.sessionRow(page, project, inst.sessionId);
  await expect.poll(() => row.count()).toBe(1);
  await row.click();
  await expect(ui.sessionHeader(page).locator(`[title="session ${inst.sessionId}"]`)).toBeVisible();
  const card = ui.questionCard(page);
  await expect(card).toHaveCount(1);
  await expectLockedOn(ui, card, 'Apple', 'Banana', '');
  await expect(ui.wakeFold(page)).toHaveCount(1);
  expect(await ui.answerRows(ui.answerBubble(page))).toEqual([{ kind: 'option', choices: ['Apple'], note: null, custom: null }]);
  // Last on purpose: the card and its lock above prove the replayed transcript is on screen, so this absence is not vacuous.
  await expect(ui.transcript(page)).not.toContainText('mid-turn');
});

// Conversation part 3b (card 2026-0652)
test('between turns a prompt offers Rewind and Fork; mid-turn Rewind is disabled while Fork stays enabled, on the earlier prompt and on the running one', async ({ page, cc, ui, uniq }) => {
  // Invariant: the bubble actions follow the instance's status: both enabled while idle; mid-turn, Rewind disabled and Fork enabled on every bubble, existing or new.
  const project = uniq('midturn-actions');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  try {
    await ui.sendPrompt(page, 'MIDTURN-FIRST an ordinary prompt');
    await expect(ui.turnEnds(page)).toHaveCount(1);
    const first = ui.userMessages(page).first();
    await expect(ui.bubbleAction(first, 'rewind')).toBeEnabled();
    await expect(ui.bubbleAction(first, 'fork')).toBeEnabled();
    await ui.sendPrompt(page, 'MIDTURN-HOLD keep the turn running');
    await expect(ui.userMessages(page)).toHaveCount(2);
    await expect.poll(async () =>
      (await api<{ id: string; status: string }[]>(cc, 'GET', '/api/instances')).body.find((i) => i.id === inst.id)?.status,
    { message: 'fixture check: the held turn keeps the instance mid-turn' }).toBe('turn');
    const held = ui.userMessages(page).nth(1);
    await expect(ui.bubbleAction(first, 'rewind')).toBeDisabled();
    await expect(ui.bubbleAction(first, 'fork')).toBeEnabled();
    await expect(ui.bubbleAction(held, 'rewind')).toBeDisabled();
    await expect(ui.bubbleAction(held, 'fork')).toBeEnabled();
  } finally {
    // Every send sits inside the try: a held turn, or a first turn that never ends, must not leak into the shared cc.
    await api(cc, 'DELETE', `/api/instances/${inst.id}`);
  }
});

test('a refused fork shows the server\'s message and leaves the session where it was', async ({ page, cc, ui, uniq }) => {
  // Invariant: a fork the server refuses reports the server's own message, and the UI stays on the session it forked from.
  const project = uniq('fork-refused');
  const refusal = uniq('prompt 0 has not been written to the session transcript yet');
  await createProject(cc, project);
  const forks: unknown[] = [];
  // Page-local: the shared cc never sees the fork.
  await page.route('**/api/instances/*/fork', async (route) => {
    forks.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error: refusal, code: 'PROMPT_NOT_PERSISTED' } });
  });
  await ui.open(page);
  await ui.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  const prompt = 'FORK-REFUSED the prompt to fork from';
  await ui.sendPrompt(page, prompt);
  await expect(ui.turnEnds(page)).toHaveCount(1);
  const shown = await ui.forkRefused(page, ui.userMessages(page).first());
  expect(shown).toMatch(/fork failed/i);
  expect(shown).toContain(refusal);
  expect(forks).toEqual([{ userMessageIndex: 0, text: prompt }]);
  await expect(ui.sessionHeader(page).locator(`[title="session ${inst.sessionId}"]`)).toBeVisible();
});
