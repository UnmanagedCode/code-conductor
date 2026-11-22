// The headless argv contract (src/headless/args.ts): which argv makes a
// headless run, which is an ordinary boot, which is a usage error (and in which
// output format it is reported); and how the prompt is read from a file or stdin.

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
    { kind: 'headless', source: { prompt: 'do it' }, mode: 'code', format: 'json', includeWorkers: false });
  assert.deepEqual(parseHeadlessArgs(['--prompt=do=it']),
    { kind: 'headless', source: { prompt: 'do=it' }, mode: 'code', format: 'json', includeWorkers: false });
  assert.deepEqual(parseHeadlessArgs(['--prompt-file', 'p.md', '--mode', 'plan']),
    { kind: 'headless', source: { file: 'p.md' }, mode: 'plan', format: 'json', includeWorkers: false });
  assert.deepEqual(parseHeadlessArgs(['--mode=code', '--prompt-file=-']),
    { kind: 'headless', source: { file: '-' }, mode: 'code', format: 'json', includeWorkers: false });
});

test('a value is taken verbatim, even one that looks like a flag', () => {
  assert.deepEqual(parseHeadlessArgs(['--prompt', '--mode']),
    { kind: 'headless', source: { prompt: '--mode' }, mode: 'code', format: 'json', includeWorkers: false });
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

// Invariant (the parse contract): each format in both value forms, and
// --include-workers with stream-json.
test('--output-format takes each format in both forms; --include-workers needs stream-json', () => {
  for (const format of ['text', 'json', 'stream-json']) {
    assert.deepEqual(parseHeadlessArgs(['--prompt', 'a', '--output-format', format]),
      { kind: 'headless', source: { prompt: 'a' }, mode: 'code', format, includeWorkers: false });
    assert.deepEqual(parseHeadlessArgs([`--output-format=${format}`, '--prompt', 'a']),
      { kind: 'headless', source: { prompt: 'a' }, mode: 'code', format, includeWorkers: false });
  }
  assert.deepEqual(parseHeadlessArgs(['--include-workers', '--prompt', 'a', '--output-format', 'stream-json']),
    { kind: 'headless', source: { prompt: 'a' }, mode: 'code', format: 'stream-json', includeWorkers: true });
});

// Invariant (spec 1): every argv that is a usage error today keeps today's exact
// message and reports in json, so today's usage objects are byte-identical.
const TODAYS_MESSAGES = [
  [['--mode', 'plan'], '--mode needs --prompt or --prompt-file'],
  [['--prompt', 'a', '--prompt-file', 'b'], 'give --prompt or --prompt-file, not both'],
  [['--prompt', 'a', '--prompt', 'b'], '--prompt given more than once'],
  [['--prompt'], '--prompt needs a value'],
  [['--prompt='], '--prompt needs a value'],
  [['--prompt', 'a', '--mode', 'foo'], "--mode must be one of code | plan, got 'foo'"],
  [['foo', '--prompt', 'a'], "unexpected argument 'foo' in a headless run"],
  [['--prompt', 'a', '--verbose'], "unexpected argument '--verbose' in a headless run"],
  [['foo', '--prompt'], "unexpected argument 'foo' in a headless run"],
];
for (const [argv, message] of TODAYS_MESSAGES) {
  test(`today's usage message is unchanged: ${JSON.stringify(argv)}`, () => {
    assert.deepEqual(parseHeadlessArgs(argv), { kind: 'usage', message, format: 'json' });
  });
}

// Invariant: the two new flags alone make the argv headless, and only they get
// the new no-prompt wording.
test('--output-format or --include-workers alone is a headless argv needing a prompt', () => {
  assert.deepEqual(parseHeadlessArgs(['--output-format', 'json']),
    { kind: 'usage', message: 'a headless run needs --prompt or --prompt-file', format: 'json' });
  assert.deepEqual(parseHeadlessArgs(['--include-workers']),
    { kind: 'usage', message: 'a headless run needs --prompt or --prompt-file', format: 'json' });
});

// Invariant: each misuse of the new flags is a usage error naming its cause.
const NEW_USAGE = [
  [['--prompt', 'a', '--output-format', 'xml'], "--output-format must be one of text | json | stream-json, got 'xml'"],
  [['--prompt', 'a', '--output-format', 'json', '--output-format=text'], '--output-format given more than once'],
  [['--prompt', 'a', '--output-format'], '--output-format needs a value'],
  [['--prompt', 'a', '--include-workers=yes', '--output-format', 'stream-json'], '--include-workers takes no value'],
  [['--prompt', 'a', '--include-workers', '--include-workers', '--output-format', 'stream-json'], '--include-workers given more than once'],
  [['--prompt', 'a', '--include-workers', '--output-format', 'json'], '--include-workers needs --output-format stream-json'],
  [['--prompt', 'a', '--include-workers', '--output-format', 'text'], '--include-workers needs --output-format stream-json'],
  [['--prompt', 'a', '--include-workers'], '--include-workers needs --output-format stream-json'],
];
for (const [argv, message] of NEW_USAGE) {
  test(`usage error, new flags: ${JSON.stringify(argv)}`, () => {
    const r = parseHeadlessArgs(argv);
    assert.equal(r.kind, 'usage', JSON.stringify(r));
    assert.equal(r.message, message);
  });
}

// Invariant: early failures are reported in the requested format — the parsed
// --output-format when valid, else json.
test('a usage result carries the requested format when it is valid, else json', () => {
  assert.equal(parseHeadlessArgs(['--output-format', 'stream-json', '--prompt', 'a', '--mode', 'x']).format, 'stream-json');
  assert.equal(parseHeadlessArgs(['--output-format', 'text', '--include-workers', '--prompt', 'a']).format, 'text');
  assert.equal(parseHeadlessArgs(['--output-format', 'xml', '--prompt', 'a']).format, 'json');
  const stray = parseHeadlessArgs(['foo', '--output-format', 'stream-json', '--prompt', 'a']);
  assert.deepEqual(stray, { kind: 'usage', message: "unexpected argument 'foo' in a headless run", format: 'stream-json' });
});

// Invariant: values stay verbatim, the new flag names included.
test('--prompt --output-format is the prompt "--output-format", format json', () => {
  assert.deepEqual(parseHeadlessArgs(['--prompt', '--output-format']),
    { kind: 'headless', source: { prompt: '--output-format' }, mode: 'code', format: 'json', includeWorkers: false });
});

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

test('a stdin that fails mid-read is a usage error, not a throw', async () => {
  const stdin = new Readable({ read() { this.destroy(new Error('EIO: stdin went away')); } });
  const r = await readHeadlessPrompt({ file: '-' }, { readFile: noFile, stdin });
  assert.equal(r.kind, 'usage');
  assert.match(r.message, /stdin.*EIO/);
});
