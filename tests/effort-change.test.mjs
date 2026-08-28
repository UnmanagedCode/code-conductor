// Server side of the ⋮ menu's "⚡ Change effort": Instance.setEffort().
//
// There is no `set_effort` control_request — the CLI answers only
// set_permission_mode / set_model / interrupt — so a live effort change is a
// `/effort <level>` line written to the session's stdin, which the CLI runs as
// a LOCAL slash command (no model turn, zero tokens). Everything fragile about
// that mechanism is pinned here:
//   - the exact wire shape (a LONE text block; the CLI only recognises the
//     slash command when the message is nothing else);
//   - level validation happening BEFORE the write, so junk can never land as
//     prose in the conversation;
//   - the idle-only refusal (mid-turn the CLI folds the line into the running
//     turn's input);
//   - that it bypasses prompt() (which would set firstPrompt, park the line in
//     the overage queue, and cancel a pending auto-resume);
//   - that it still emits a user_echo, because the CLI persists the line as a
//     jsonl `type:"user"` line that isPureUserPromptLine counts.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, userStdinLines } from './helpers.mjs';
import { isPureUserPromptLine } from '../src/transcript.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, transcriptPath;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
  // Must be set BEFORE the instance launches — the fake engine opens the file
  // at startup and appends every stdin line it receives.
  transcriptPath = path.join(home, 'transcript.log');
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
});
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  await instances.shutdown();
  await rmrf(home);
});

// The fake engine creates the transcript lazily, so an absent file means the
// same thing an empty one does: nothing has been written to the CLI's stdin.
async function stdinLines() {
  try { return await userStdinLines(transcriptPath); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

const textOf = (line) => line.message?.content?.[0]?.text;

// The engine appends each received line asynchronously, so every POSITIVE
// assertion waits for the write to land rather than sampling. It waits on the
// line COUNT, not on the expected text — waiting for the text would turn a
// wrong-shape regression into a timeout instead of a diff. (Every "nothing was
// written" assertion below is anchored on a line that DID arrive, for the same
// reason: an unanchored empty read would also pass while a bad write was still
// in flight. Writes are ordered on one stdin stream, so a line written earlier
// can never surface after one written later.)
function awaitStdinCount(n) {
  return waitFor(async () => (await stdinLines()).length >= n);
}

async function liveInstance() {
  const created = await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  assert.equal(created.status, 201);
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

test('setEffort writes exactly one lone-text `/effort <level>` line to the CLI stdin', async () => {
  const inst = await liveInstance();
  assert.deepEqual(await stdinLines(), [], 'sanity: nothing sent yet');

  inst.setEffort('max');
  await awaitStdinCount(1);

  assert.deepEqual(await stdinLines(), [{
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '/effort max' }] },
    parent_tool_use_id: null,
  }], 'the CLI only treats it as a local slash command when the message is a LONE text block — '
    + 'no MID_TURN_NOTE sibling, no attachment blocks, no reformatting of the level');
});

test('setEffort moves this.effort, and therefore every summary-fed surface', async () => {
  const inst = await liveInstance();
  assert.notEqual(inst.effort, 'max', 'sanity: not already there');

  inst.setEffort('max');

  assert.equal(inst.effort, 'max');
  // The single write site: summary() is what feeds the header, the sidebar,
  // /api/instances, the WS status frames, MCP list_sessions and the restart
  // manifest; `--effort this.effort` and fork's createArgs read the same field.
  assert.equal(inst.summary().effort, 'max');
});

test('an unknown level is refused before anything reaches the CLI', async () => {
  const inst = await liveInstance();

  assert.throws(() => inst.setEffort('turbo'), /invalid effort/);
  assert.notEqual(inst.effort, 'turbo');

  // A valid change follows, and the transcript must hold nothing but IT: the
  // refused level was never written. (Asserting an empty transcript straight
  // after the throw would also pass while a junk write was still in flight.)
  inst.setEffort('low');
  await awaitStdinCount(1);
  assert.deepEqual((await stdinLines()).map(textOf), ['/effort low'],
    'validation runs first, so arbitrary text can never be written to stdin — where it '
    + 'would land as an ordinary prose message instead of a slash command');
});

test('setEffort during a running turn is refused 409 and changes nothing', async () => {
  const inst = await liveInstance();
  // The scenario's 2nd turn pauses mid-stream (no turn_end) — that is what
  // catches the instance in `turn`.
  await inst.prompt('first');
  await waitFor(() => inst.status === 'idle');
  await inst.prompt('hang');
  await waitFor(() => inst.status === 'turn');

  // Both prompts have already been consumed by the engine (that is what moved
  // the status), so this baseline is settled — nothing is in flight.
  const before = inst.effort;
  const linesBefore = (await stdinLines()).map(textOf);
  assert.deepEqual(linesBefore, ['first', 'hang'], 'sanity: the baseline is the two prompts');
  assert.throws(() => inst.setEffort('low'), (e) => e.statusCode === 409);

  assert.equal(inst.effort, before);
  assert.deepEqual((await stdinLines()).map(textOf), linesBefore,
    'mid-turn the CLI queues an incoming line and flushes it combined with the next '
    + "turn's input, so it would stop being a lone message and land as prose");
});

test('setEffort bypasses prompt(): no firstPrompt, no user_prompt event', async () => {
  const inst = await liveInstance();
  assert.equal(inst.firstPrompt, null, 'sanity: never prompted');
  const userPrompts = [];
  inst.on('user_prompt', (p) => userPrompts.push(p));

  inst.setEffort('low');

  // Routing through prompt() would title the session "/effort low" in the
  // sidebar, park the line in the overage queue during an overage window (where
  // it is delivered COMBINED with other queued text and silently stops being a
  // slash command), and cancel a pending overage auto-resume.
  assert.equal(inst.firstPrompt, null);
  assert.deepEqual(userPrompts, []);
});

test('setEffort emits the user_echo that keeps live bubbles aligned with the jsonl', async () => {
  const inst = await liveInstance();

  inst.setEffort('low');

  const echoes = inst.ringSnapshot().filter(ev => ev.kind === 'user_echo');
  assert.deepEqual(echoes.map(ev => ev.text), ['/effort low']);

  // …and this is WHY the echo is load-bearing rather than cosmetic: the CLI
  // persists the same line in the session jsonl, where isPureUserPromptLine
  // counts it — and userMessageIndex for rewind/fork is a 0-based count over
  // those lines. Suppressing the live bubble would shift every index by one.
  assert.equal(isPureUserPromptLine({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '/effort low' }] },
  }), true, 'if this ever stops counting, the user_echo above must be reconsidered with it');
});
