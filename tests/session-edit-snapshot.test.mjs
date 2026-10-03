// The two pure pieces a mid-turn fork builds on (src/sessionEdit.ts):
// `completeLinesOf`, which drops a partially written trailing line before
// anything counts or copies lines, and `splitAtUserMessage`'s out-of-range
// refusal, whose `code` is what the fork's wait decision branches on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeLinesOf, splitAtUserMessage, PROMPT_OUT_OF_RANGE, PROMPT_MISMATCH } from '../src/sessionEdit.ts';

const line = (obj) => JSON.stringify(obj) + '\n';
const prompt = (uuid, content) => line({ type: 'user', uuid, message: { role: 'user', content } });

test('completeLinesOf', async (t) => {
  await t.test('drops an unterminated tail', () => {
    const whole = prompt('u1', 'first');
    assert.equal(completeLinesOf(whole + '{"type":"assistant","mess'), whole);
  });
  await t.test('drops a tail holding a multibyte character, keeping complete multibyte lines', () => {
    const whole = prompt('u1', 'héllo ⑂ 🙂');
    const text = completeLinesOf(whole + '{"type":"user","message":{"content":"⑂ 🙂');
    assert.equal(text, whole);
    assert.equal(JSON.parse(text.trim()).message.content, 'héllo ⑂ 🙂');
  });
  await t.test('a text with no newline at all is entirely partial', () => {
    assert.equal(completeLinesOf('{"type":"user"'), '');
  });
  await t.test('a fully terminated text is unchanged', () => {
    const whole = prompt('u1', 'first') + prompt('u2', 'second');
    assert.equal(completeLinesOf(whole), whole);
  });
});

test('splitAtUserMessage', async (t) => {
  const text = prompt('u1', 'first') + line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'r' }] } })
    + prompt('u2', 'second');

  await t.test('an index past the last prompt throws a 400 carrying code PROMPT_OUT_OF_RANGE', () => {
    assert.throws(() => splitAtUserMessage(text, { userMessageIndex: 2, expectedText: 'third' }),
      (e) => e.statusCode === 400 && e.code === PROMPT_OUT_OF_RANGE && /out of range \(session has 2 user prompts\)/.test(e.message));
  });
  await t.test('a wrong text at a present index is the PROMPT_MISMATCH 409, without that code', () => {
    assert.throws(() => splitAtUserMessage(text, { userMessageIndex: 1, expectedText: 'not second' }),
      (e) => e.statusCode === 409 && e.message.startsWith(PROMPT_MISMATCH) && e.code !== PROMPT_OUT_OF_RANGE);
  });
  await t.test('a present index splits before the prompt', () => {
    const r = splitAtUserMessage(text, { userMessageIndex: 1, expectedText: 'second' });
    assert.deepEqual(r.prefix.map(e => e.obj.uuid), ['u1', 'a1']);
    assert.deepEqual(r.dropped.map(e => e.obj.uuid), ['u2']);
    assert.equal(r.droppedText, 'second');
  });
});
