// The headless argv contract (src/headless/args.ts): which argv makes a
// headless run, which is an ordinary boot, which is a usage error; and how the
// prompt is read from a file or stdin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseHeadlessArgs, readHeadlessPrompt } from '../src/headless/args.ts';

test('an argv with no headless flag is an ordinary boot, whatever else it holds', () => {
  assert.deepEqual(parseHeadlessArgs([]), { kind: 'none' });
  assert.deepEqual(parseHeadlessArgs(['--inspect', 'foo', '--promptly']), { kind: 'none' });
  assert.deepEqual(parseHeadlessArgs(['--prompt-files', 'x']), { kind: 'none' });
});

test('both value forms of each flag are accepted; mode defaults to code', () => {
  assert.deepEqual(parseHeadlessArgs(['--prompt', 'do it']),
    { kind: 'headless', source: { prompt: 'do it' }, mode: 'code' });
  assert.deepEqual(parseHeadlessArgs(['--prompt=do=it']),
    { kind: 'headless', source: { prompt: 'do=it' }, mode: 'code' });
  assert.deepEqual(parseHeadlessArgs(['--prompt-file', 'p.md', '--mode', 'plan']),
    { kind: 'headless', source: { file: 'p.md' }, mode: 'plan' });
  assert.deepEqual(parseHeadlessArgs(['--mode=code', '--prompt-file=-']),
    { kind: 'headless', source: { file: '-' }, mode: 'code' });
});

test('a value is taken verbatim, even one that looks like a flag', () => {
  assert.deepEqual(parseHeadlessArgs(['--prompt', '--mode']),
    { kind: 'headless', source: { prompt: '--mode' }, mode: 'code' });
});

const usage = [
  ['both prompt flags', ['--prompt', 'a', '--prompt-file', 'b']],
  ['a repeated --prompt', ['--prompt', 'a', '--prompt', 'b']],
  ['a repeated --mode', ['--prompt', 'a', '--mode', 'code', '--mode=plan']],
  ['--prompt with no value', ['--prompt']],
  ['--prompt= with an empty value', ['--prompt=']],
  ['--prompt-file with no value', ['--prompt-file']],
  ['--mode with no value', ['--prompt', 'a', '--mode']],
  ['an unknown --mode', ['--prompt', 'a', '--mode', 'foo']],
  ['--mode alone', ['--mode', 'plan']],
  ['a stray argument before a headless flag', ['foo', '--prompt', 'a']],
  ['a stray argument after a headless flag', ['--prompt', 'a', '--verbose']],
];
for (const [name, argv] of usage) {
  test(`usage error: ${name}`, () => {
    const r = parseHeadlessArgs(argv);
    assert.equal(r.kind, 'usage', JSON.stringify(r));
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
  });
}

const noFile = async () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); };

test('readHeadlessPrompt returns an inline prompt as given', async () => {
  assert.deepEqual(await readHeadlessPrompt({ prompt: ' hi ' }, { readFile: noFile, stdin: Readable.from([]) }),
    { kind: 'prompt', text: ' hi ' });
});

test('readHeadlessPrompt reads a prompt file', async () => {
  const seen = [];
  const readFile = async (p) => { seen.push(p); return 'from the file\n'; };
  assert.deepEqual(await readHeadlessPrompt({ file: 'p.md' }, { readFile, stdin: Readable.from([]) }),
    { kind: 'prompt', text: 'from the file\n' });
  assert.deepEqual(seen, ['p.md']);
});

test('readHeadlessPrompt reads all of stdin for "-"', async () => {
  const stdin = Readable.from([Buffer.from('line one\n'), Buffer.from('line two')]);
  assert.deepEqual(await readHeadlessPrompt({ file: '-' }, { readFile: noFile, stdin }),
    { kind: 'prompt', text: 'line one\nline two' });
});

test('an unreadable prompt file is a usage error naming the file', async () => {
  const r = await readHeadlessPrompt({ file: 'missing.md' }, { readFile: noFile, stdin: Readable.from([]) });
  assert.equal(r.kind, 'usage');
  assert.match(r.message, /missing\.md/);
});

for (const [name, source, opts] of [
  ['an empty inline prompt', { prompt: '' }, {}],
  ['a whitespace-only inline prompt', { prompt: ' \n\t' }, {}],
  ['a whitespace-only prompt file', { file: 'p.md' }, { readFile: async () => '  \n' }],
  ['an empty stdin', { file: '-' }, { stdin: Readable.from([]) }],
]) {
  test(`usage error: ${name}`, async () => {
    const r = await readHeadlessPrompt(source, { readFile: noFile, stdin: Readable.from([]), ...opts });
    assert.equal(r.kind, 'usage', JSON.stringify(r));
  });
}
