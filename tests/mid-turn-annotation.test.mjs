// Verify that prompt() prepends a <system-reminder> annotation when the
// instance is mid-turn, and that the user_echo event is never annotated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Instance } from '../src/instances.js';

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
