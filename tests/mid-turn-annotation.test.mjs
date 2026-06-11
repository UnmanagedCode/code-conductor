// Verify that prompt() prepends a <system-reminder> annotation when the
// instance is mid-turn, that the user_echo event is never annotated, and that
// both the transcript-replay path and the live-parser path strip the
// annotation block so it never appears in a rendered user bubble.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Instance, MID_TURN_NOTE } from '../src/instances.js';
import { isMidTurnNoteContent, Parser } from '../src/parser.js';
import { replayPersistedLine } from '../src/transcript.js';

// Returns a minimal fake proc + the array of lines written to its stdin.
function makeProc() {
  const lines = [];
  return {
    proc: {
      stdin: {
        writable: true,
        write(line) { lines.push(line); },
      },
      stdout: { on() {} },
      stderr: { on() {} },
      on() {},
      kill() {},
    },
    lines,
  };
}

// Build a bare-minimum Instance with its proc pre-wired and status set.
function makeInst(status = 'idle') {
  const inst = new Instance({
    id: 'test-1',
    project: 'demo',
    cwd: '/tmp',
    mode: 'bypassPermissions',
    effort: 'high',
    thinking: 'adaptive',
    model: null,
  });
  const { proc, lines } = makeProc();
  inst.proc = proc;
  inst.status = status;
  return { inst, lines };
}

// Parse the last user-type stdin line and return its content array.
function lastUserContent(lines) {
  const userLines = lines
    .map(l => JSON.parse(l.trim()))
    .filter(o => o.type === 'user' && o.message?.role === 'user');
  assert.ok(userLines.length > 0, 'no user stdin line found');
  return userLines[userLines.length - 1].message.content;
}

test('idle send — no mid-turn annotation', async () => {
  const { inst, lines } = makeInst('idle');
  const echos = [];
  inst.on('event', ev => { if (ev.kind === 'user_echo') echos.push(ev); });

  await inst.prompt('hello world');

  const content = lastUserContent(lines);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, 'hello world');
});

test('mid-turn send — annotation prepended, user text verbatim', async () => {
  const { inst, lines } = makeInst('turn');
  const echos = [];
  inst.on('event', ev => { if (ev.kind === 'user_echo') echos.push(ev); });

  await inst.prompt('steer me');

  const content = lastUserContent(lines);
  // Two blocks: annotation first, then the user's text.
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'text');
  assert.ok(
    content[0].text.startsWith('<system-reminder>'),
    'first block is the system-reminder annotation',
  );
  assert.ok(
    content[0].text.includes('mid-turn'),
    'annotation mentions mid-turn',
  );
  // User's text is verbatim and unchanged.
  assert.equal(content[1].type, 'text');
  assert.equal(content[1].text, 'steer me');
});

test('mid-turn send with annotateIfMidTurn:false — no annotation', async () => {
  const { inst, lines } = makeInst('turn');

  await inst.prompt('system msg', [], { annotateIfMidTurn: false });

  const content = lastUserContent(lines);
  assert.equal(content.length, 1);
  assert.equal(content[0].text, 'system msg');
});

test('user_echo text is never annotated regardless of turn state', async () => {
  const { inst } = makeInst('turn');
  const echos = [];
  inst.on('event', ev => { if (ev.kind === 'user_echo') echos.push(ev); });

  await inst.prompt('check me');

  assert.equal(echos.length, 1);
  assert.equal(echos[0].text, 'check me', 'user_echo carries only the raw user text');
  assert.ok(
    !echos[0].text.includes('system-reminder'),
    'no annotation leaked into user_echo',
  );
});

// ---------------------------------------------------------------------------
// isMidTurnNoteContent predicate
// ---------------------------------------------------------------------------

test('isMidTurnNoteContent matches the actual MID_TURN_NOTE constant', () => {
  assert.equal(isMidTurnNoteContent(MID_TURN_NOTE), true);
});

test('isMidTurnNoteContent rejects ordinary text', () => {
  assert.equal(isMidTurnNoteContent('hello world'), false);
  assert.equal(isMidTurnNoteContent(''), false);
  assert.equal(isMidTurnNoteContent(undefined), false);
  assert.equal(isMidTurnNoteContent(null), false);
});

test('isMidTurnNoteContent requires all three signals', () => {
  // Missing opening tag
  assert.equal(isMidTurnNoteContent('mid-turn context\n</system-reminder>'), false);
  // Missing mid-turn token
  assert.equal(isMidTurnNoteContent('<system-reminder>\nsome note\n</system-reminder>'), false);
  // Missing closing tag
  assert.equal(isMidTurnNoteContent('<system-reminder>\nmid-turn note'), false);
});

// ---------------------------------------------------------------------------
// Transcript replay path (type:"user" persisted line)
// ---------------------------------------------------------------------------

function midTurnUserLine(userText) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: MID_TURN_NOTE },
        { type: 'text', text: userText },
      ],
    },
  };
}

test('transcript replay strips annotation — user_echo contains only user text', () => {
  const evs = replayPersistedLine(midTurnUserLine('actual request'));
  const echo = evs.find(e => e.kind === 'user_echo');
  assert.ok(echo, 'user_echo was emitted');
  assert.equal(echo.text, 'actual request');
  assert.ok(!echo.text.includes('system-reminder'), 'no annotation in replayed bubble');
  assert.ok(!echo.text.includes('mid-turn'), 'mid-turn token not in replayed bubble');
});

test('transcript replay: annotation-only message emits no user_echo', () => {
  const line = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: MID_TURN_NOTE }],
    },
  };
  const evs = replayPersistedLine(line);
  assert.equal(evs.filter(e => e.kind === 'user_echo').length, 0);
});

// ---------------------------------------------------------------------------
// Transcript replay path (type:"attachment" queued_command — mid-turn shape)
// ---------------------------------------------------------------------------

test('transcript replay strips annotation from queued_command shape', () => {
  const line = {
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: [
        { type: 'text', text: MID_TURN_NOTE },
        { type: 'text', text: 'queued request' },
      ],
    },
  };
  const evs = replayPersistedLine(line);
  const echo = evs.find(e => e.kind === 'user_echo');
  assert.ok(echo, 'user_echo was emitted');
  assert.equal(echo.text, 'queued request');
  assert.ok(!echo.text.includes('system-reminder'), 'no annotation in queued_command bubble');
});

// ---------------------------------------------------------------------------
// Live parser path (_handleUser)
// ---------------------------------------------------------------------------

test('live parser strips annotation — user_echo contains only user text', () => {
  const p = new Parser();
  const evs = p.handleObject({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: MID_TURN_NOTE },
        { type: 'text', text: 'live request' },
      ],
    },
  });
  const echo = evs.find(e => e.kind === 'user_echo');
  assert.ok(echo, 'user_echo was emitted');
  assert.equal(echo.text, 'live request');
  assert.ok(!echo.text.includes('system-reminder'), 'no annotation in live bubble');
});
