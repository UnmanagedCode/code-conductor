// Tests for public/forwardFrame.js's parse side: parseForwardFrame recovers
// { payload, instruction } from exactly what buildForwardFrame writes, and
// splitForwardedMessages recovers the per-message bodies from the payload.
// Pure — no DOM. The worker-visible bytes themselves are pinned against the
// real send_prompt builder in tests/mcp-forward.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORWARD_FRAME_HEADER, FORWARD_FRAME_FOOTER,
  buildForwardFrame, parseForwardFrame, splitForwardedMessages,
} from '../public/forwardFrame.js';

const H = FORWARD_FRAME_HEADER;
const F = FORWARD_FRAME_FOOTER;

test('build→parse→split round-trips one message and several, instruction byte-exact', async (t) => {
  await t.test('one message', () => {
    const messages = ['--- plan ---\nStep 1\nStep 2'];
    const parsed = parseForwardFrame(buildForwardFrame({ messages, instruction: 'go' }));
    assert.equal(parsed.instruction, 'go');
    assert.deepEqual(splitForwardedMessages(parsed.payload), messages);
  });
  await t.test('three messages, instruction with surrounding whitespace', () => {
    const messages = ['first **x**', '--- questions ---\n1. Q one', 'third\n\nwith a blank line'];
    const instruction = '\n  review these, then report  \n';
    const parsed = parseForwardFrame(buildForwardFrame({ messages, instruction }));
    assert.equal(parsed.instruction, instruction);
    assert.deepEqual(splitForwardedMessages(parsed.payload), messages);
  });
});

test('a payload quoting the footer as its own paragraph stays in the payload', () => {
  const messages = [`the frame ends with\n\n${F}\n\nand then the instruction`];
  const parsed = parseForwardFrame(buildForwardFrame({ messages, instruction: 'review it' }));
  assert.equal(parsed.instruction, 'review it');
  assert.equal(parsed.payload, messages[0]);
});

test('an instruction containing a footer paragraph splits there and loses no byte', async (t) => {
  await t.test('mid-instruction footer paragraph', () => {
    const payload = 'worker output';
    const text = buildForwardFrame({ messages: [payload], instruction: `head\n\n${F}\n\ntail` });
    const parsed = parseForwardFrame(text);
    assert.equal(parsed.payload, `${payload}\n\n${F}\n\nhead`, 'the instruction head lands in the payload');
    assert.equal(parsed.instruction, 'tail');
    assert.equal(`${H}\n\n${parsed.payload}\n\n${F}\n\n${parsed.instruction}`, text,
      'header + payload + footer + instruction reconstructs the input');
  });
  await t.test('footer paragraph ending the instruction', () => {
    const text = buildForwardFrame({ messages: ['worker output'], instruction: `head\n\n${F}` });
    const parsed = parseForwardFrame(text);
    assert.equal(parsed.payload, `worker output\n\n${F}\n\nhead`);
    assert.equal(parsed.instruction, '');
  });
});

test('a last footer that is not paragraph-final recedes to an earlier one that is', () => {
  const text = `${H}\n\np\n\n${F}\n\ntail\n\n${F}\ntail2`;
  assert.deepEqual(parseForwardFrame(text), { payload: 'p', instruction: `tail\n\n${F}\ntail2` });
});

test('footer text not standing as its own paragraph does not move the split', async (t) => {
  for (const [label, body] of [
    ['inline mention', `see ${F} above`],
    ['footer paragraph with trailing text on its line', `x\n\n${F} trailing`],
  ]) {
    await t.test(label, () => {
      const parsed = parseForwardFrame(buildForwardFrame({ messages: [body], instruction: 'go' }));
      assert.equal(parsed.payload, body);
      assert.equal(parsed.instruction, 'go');
    });
  }
});

test('an empty instruction parses to the empty string, trimmed replay included', async (t) => {
  const built = buildForwardFrame({ messages: ['out'], instruction: '' });
  await t.test('as built (ends FOOTER + blank line)', () => {
    assert.ok(built.endsWith(`${F}\n\n`));
    assert.deepEqual(parseForwardFrame(built), { payload: 'out', instruction: '' });
  });
  await t.test('trailing whitespace trimmed (ends FOOTER)', () => {
    assert.deepEqual(parseForwardFrame(built.trimEnd()), { payload: 'out', instruction: '' });
  });
});

test('an empty payload parses without throwing', () => {
  assert.deepEqual(parseForwardFrame(buildForwardFrame({ messages: [''], instruction: 'go' })),
    { payload: '', instruction: 'go' });
});

test('anything that is not a whole frame at offset 0 returns null', async (t) => {
  const firstLine = H.slice(0, H.indexOf('\n'));
  const cases = {
    'truncated (no footer)': `${H}\n\nworker output cut short`,
    'header first line only': `${firstLine}\nout\n\n${F}\n\ngo`,
    'text before the header': `steer\n\n${buildForwardFrame({ messages: ['out'], instruction: 'go' })}`,
    'header without its blank-line join': `${H}\nout\n\n${F}\n\ngo`,
  };
  for (const [label, text] of Object.entries(cases)) {
    await t.test(label, () => assert.equal(parseForwardFrame(text), null));
  }
  await t.test('non-string input', () => {
    assert.equal(parseForwardFrame(null), null);
    assert.equal(parseForwardFrame(undefined), null);
    assert.equal(parseForwardFrame(42), null);
  });
});

test('splitForwardedMessages scans backwards and falls back to one body on inconsistent boundaries', async (t) => {
  await t.test('message 1 quoting a later boundary line still splits correctly', () => {
    const messages = ['quoting\n\n--- message 2/3 ---\nfake body', 'real two', 'real three'];
    const payload = parseForwardFrame(buildForwardFrame({ messages, instruction: 'go' })).payload;
    assert.deepEqual(splitForwardedMessages(payload), messages);
  });
  await t.test('a later message quoting an earlier boundary line still splits correctly', () => {
    const messages = ['real one', 'real two', 'three quoting\n\n--- message 2/3 ---\nfake body'];
    const payload = parseForwardFrame(buildForwardFrame({ messages, instruction: 'go' })).payload;
    assert.deepEqual(splitForwardedMessages(payload), messages);
  });
  await t.test('a boundary sequence anywhere but offset 0 is one body', () => {
    const body = 'quoting a frame:\n--- message 1/3 ---\na\n\n--- message 2/3 ---\nb\n\n--- message 3/3 ---\nc';
    const payload = parseForwardFrame(buildForwardFrame({ messages: [body], instruction: 'go' })).payload;
    assert.deepEqual(splitForwardedMessages(payload), [body]);
  });
  await t.test('a missing boundary yields the whole payload', () => {
    const payload = '--- message 1/3 ---\none\n\n--- message 2/3 ---\ntwo';
    assert.deepEqual(splitForwardedMessages(payload), [payload]);
  });
  await t.test('a single body opening with a 1/2 boundary and no 2/2 stays one body', () => {
    const payload = '--- message 1/2 ---\nlooks like a boundary but is the whole message';
    assert.deepEqual(splitForwardedMessages(payload), [payload]);
  });
  await t.test('a payload with no boundary is one body', () => {
    assert.deepEqual(splitForwardedMessages('just one'), ['just one']);
  });
});
