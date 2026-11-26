// The entry argv contract (src/headless/args.ts parseEntryArgs): which argv
// makes a headless run, a replay or an ordinary boot, which UI mode each runs
// in, which is a usage error (and in which output format it is reported); and
// how the prompt is read from a file or stdin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseEntryArgs, readHeadlessPrompt } from '../src/headless/args.ts';

// Invariant: an argv with no headless flag is an ordinary `full` server, and
// its unknown arguments are ignored.
test('an argv with no headless flag is an ordinary boot, whatever else it holds', () => {
  assert.deepEqual(parseEntryArgs([]), { kind: 'server', ui: 'full' });
  assert.deepEqual(parseEntryArgs(['--inspect', 'foo', '--promptly']), { kind: 'server', ui: 'full' });
  assert.deepEqual(parseEntryArgs(['--prompt-files', 'x']), { kind: 'server', ui: 'full' });
});

// Invariant: each run flag takes both value forms; a run defaults to mode code,
// format json, no workers, UI mode view.
test('both value forms of each flag are accepted; mode defaults to code', () => {
  assert.deepEqual(parseEntryArgs(['--prompt', 'do it']),
    { kind: 'headless', source: { prompt: 'do it' }, mode: 'code', format: 'json', includeWorkers: false, ui: 'view' });
  assert.deepEqual(parseEntryArgs(['--prompt=do=it']),
    { kind: 'headless', source: { prompt: 'do=it' }, mode: 'code', format: 'json', includeWorkers: false, ui: 'view' });
  assert.deepEqual(parseEntryArgs(['--prompt-file', 'p.md', '--mode', 'plan']),
    { kind: 'headless', source: { file: 'p.md' }, mode: 'plan', format: 'json', includeWorkers: false, ui: 'view' });
  assert.deepEqual(parseEntryArgs(['--mode=code', '--prompt-file=-']),
    { kind: 'headless', source: { file: '-' }, mode: 'code', format: 'json', includeWorkers: false, ui: 'view' });
});

// Invariant: a value flag consumes the next argument verbatim, even one that names a flag.
test('a value is taken verbatim, even one that looks like a flag', () => {
  assert.deepEqual(parseEntryArgs(['--prompt', '--mode']),
    { kind: 'headless', source: { prompt: '--mode' }, mode: 'code', format: 'json', includeWorkers: false, ui: 'view' });
});

// Invariant: each malformed run argv is a usage result with a non-empty message.
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
    const r = parseEntryArgs(argv);
    assert.equal(r.kind, 'usage', JSON.stringify(r));
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
  });
}

// Invariant (the parse contract): each format in both value forms, and
// --include-workers with stream-json.
test('--output-format takes each format in both forms; --include-workers needs stream-json', () => {
  for (const format of ['text', 'json', 'stream-json']) {
    assert.deepEqual(parseEntryArgs(['--prompt', 'a', '--output-format', format]),
      { kind: 'headless', source: { prompt: 'a' }, mode: 'code', format, includeWorkers: false, ui: 'view' });
    assert.deepEqual(parseEntryArgs([`--output-format=${format}`, '--prompt', 'a']),
      { kind: 'headless', source: { prompt: 'a' }, mode: 'code', format, includeWorkers: false, ui: 'view' });
  }
  assert.deepEqual(parseEntryArgs(['--include-workers', '--prompt', 'a', '--output-format', 'stream-json']),
    { kind: 'headless', source: { prompt: 'a' }, mode: 'code', format: 'stream-json', includeWorkers: true, ui: 'view' });
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
    assert.deepEqual(parseEntryArgs(argv), { kind: 'usage', message, format: 'json' });
  });
}

// Invariant: the two new flags alone make the argv headless, and only they get
// the new no-prompt wording.
test('--output-format or --include-workers alone is a headless argv needing a prompt', () => {
  assert.deepEqual(parseEntryArgs(['--output-format', 'json']),
    { kind: 'usage', message: 'a headless run needs --prompt or --prompt-file', format: 'json' });
  assert.deepEqual(parseEntryArgs(['--include-workers']),
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
    const r = parseEntryArgs(argv);
    assert.equal(r.kind, 'usage', JSON.stringify(r));
    assert.equal(r.message, message);
  });
}

// Invariant: early failures are reported in the requested format — the parsed
// --output-format when valid, else json.
test('a usage result carries the requested format when it is valid, else json', () => {
  assert.equal(parseEntryArgs(['--output-format', 'stream-json', '--prompt', 'a', '--mode', 'x']).format, 'stream-json');
  assert.equal(parseEntryArgs(['--output-format', 'text', '--include-workers', '--prompt', 'a']).format, 'text');
  assert.equal(parseEntryArgs(['--output-format', 'xml', '--prompt', 'a']).format, 'json');
  const stray = parseEntryArgs(['foo', '--output-format', 'stream-json', '--prompt', 'a']);
  assert.deepEqual(stray, { kind: 'usage', message: "unexpected argument 'foo' in a headless run", format: 'stream-json' });
});

// Invariant: values stay verbatim, the new flag names included.
test('--prompt --output-format is the prompt "--output-format", format json', () => {
  assert.deepEqual(parseEntryArgs(['--prompt', '--output-format']),
    { kind: 'headless', source: { prompt: '--output-format' }, mode: 'code', format: 'json', includeWorkers: false, ui: 'view' });
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

// Invariant: `--replay` (alone, or with --session in either value form) is a
// replay argv carrying the requested session, or null for the last run's, in
// the headless default UI mode `view`.
test('--replay parses to a replay; --session takes both value forms in either order', () => {
  assert.deepEqual(parseEntryArgs(['--replay']), { kind: 'replay', session: null, ui: 'view' });
  assert.deepEqual(parseEntryArgs(['--replay', '--session', 'a']), { kind: 'replay', session: 'a', ui: 'view' });
  assert.deepEqual(parseEntryArgs(['--session=a', '--replay']), { kind: 'replay', session: 'a', ui: 'view' });
});

// Invariant: --replay refuses every run flag beside it, naming the first one in argv order.
for (const argv of [
  ['--replay', '--prompt', 'x'],
  ['--replay', '--prompt-file', 'p.md'],
  ['--replay', '--mode', 'plan'],
  ['--replay', '--output-format', 'json'],
  ['--replay', '--include-workers'],
]) {
  test(`--replay cannot be combined with ${argv[1]}`, () => {
    assert.deepEqual(parseEntryArgs(argv), { kind: 'usage', message: `--replay cannot be combined with ${argv[1]}`, format: 'json' });
  });
}
// Invariant: the clash message names the first run flag in argv order, wherever --replay sits.
test('--replay names the first clashing flag in argv order', () => {
  assert.equal(parseEntryArgs(['--mode', 'plan', '--replay', '--prompt', 'x']).message, '--replay cannot be combined with --mode');
});

// Invariant: --session without --replay is refused before the prompt checks, so a
// run never silently ignores it.
test('--session alone needs --replay', () => {
  assert.deepEqual(parseEntryArgs(['--session', 'a']), { kind: 'usage', message: '--session needs --replay', format: 'json' });
});
test('--session with a prompt needs --replay', () => {
  assert.equal(parseEntryArgs(['--session', 'a', '--prompt', 'x']).message, '--session needs --replay');
});

// Invariant: misuse of the replay flags is a usage error naming its cause.
const REPLAY_USAGE = [
  [['--replay', '--replay'], '--replay given more than once'],
  [['--replay=1'], '--replay takes no value'],
  [['--replay', '--session'], '--session needs a value'],
  [['--replay', '--session', 'a', '--session', 'b'], '--session given more than once'],
  [['--replay', 'stray'], "unexpected argument 'stray' in a headless run"],
];
for (const [argv, message] of REPLAY_USAGE) {
  test(`usage error, replay flags: ${JSON.stringify(argv)}`, () => {
    assert.deepEqual(parseEntryArgs(argv), { kind: 'usage', message, format: 'json' });
  });
}

// ── --ui ────────────────────────────────────────────────────────────────

// Invariant: each boot family's default UI mode — an ordinary server `full`,
// a headless run and a replay `view`.
test('the default UI mode per boot: server full, headless run view, replay view', () => {
  assert.deepEqual(parseEntryArgs([]), { kind: 'server', ui: 'full' });
  assert.equal(parseEntryArgs(['--prompt', 'a']).ui, 'view');
  assert.equal(parseEntryArgs(['--replay']).ui, 'view');
});

// Invariant: `--ui <m>` and `--ui=<m>` both select the mode, in every family,
// before or after the other flags; an ordinary server accepts full and view.
test('--ui takes both value forms in each family', () => {
  for (const ui of ['full', 'view']) {
    assert.deepEqual(parseEntryArgs(['--ui', ui]), { kind: 'server', ui });
    assert.deepEqual(parseEntryArgs([`--ui=${ui}`, '--inspect']), { kind: 'server', ui });
  }
  for (const ui of ['full', 'view', 'interact']) {
    assert.deepEqual(parseEntryArgs(['--prompt', 'a', '--ui', ui]),
      { kind: 'headless', source: { prompt: 'a' }, mode: 'code', format: 'json', includeWorkers: false, ui });
    assert.deepEqual(parseEntryArgs([`--ui=${ui}`, '--prompt', 'a']),
      { kind: 'headless', source: { prompt: 'a' }, mode: 'code', format: 'json', includeWorkers: false, ui });
    assert.deepEqual(parseEntryArgs(['--replay', '--ui', ui, '--session', 's']), { kind: 'replay', session: 's', ui });
    assert.deepEqual(parseEntryArgs([`--ui=${ui}`, '--replay']), { kind: 'replay', session: null, ui });
  }
});

// Invariant: an ordinary server refuses a bad `--ui` (repeated, missing, empty,
// unknown) and `--ui interact` as server_usage naming the cause — never a
// silent full boot.
const SERVER_UI_USAGE = [
  [['--ui', 'view', '--ui', 'view'], '--ui given more than once'],
  [['--ui=full', '--ui', 'view'], '--ui given more than once'],
  [['--ui'], '--ui needs a value'],
  [['--ui='], '--ui needs a value'],
  [['--ui', 'bogus'], "--ui must be one of full | view | interact, got 'bogus'"],
  [['--ui', 'interact'], '--ui interact needs a headless run (--prompt / --prompt-file) or --replay'],
  [['--ui=interact', '--inspect'], '--ui interact needs a headless run (--prompt / --prompt-file) or --replay'],
];
for (const [argv, message] of SERVER_UI_USAGE) {
  test(`server usage error: ${JSON.stringify(argv)}`, () => {
    assert.deepEqual(parseEntryArgs(argv), { kind: 'server_usage', message });
  });
}

// Invariant: a headless run or replay reports a bad `--ui` as a usage error in
// the requested format, never as server_usage.
const HEADLESS_UI_USAGE = [
  [['--prompt', 'a', '--ui', 'bogus'], "--ui must be one of full | view | interact, got 'bogus'", 'json'],
  [['--prompt', 'a', '--output-format', 'text', '--ui'], '--ui needs a value', 'text'],
  [['--replay', '--ui'], '--ui needs a value', 'json'],
  [['--replay', '--ui='], '--ui needs a value', 'json'],
  [['--replay', '--ui', 'view', '--ui=full'], '--ui given more than once', 'json'],
];
for (const [argv, message, format] of HEADLESS_UI_USAGE) {
  test(`headless usage error, --ui: ${JSON.stringify(argv)}`, () => {
    assert.deepEqual(parseEntryArgs(argv), { kind: 'usage', message, format });
  });
}

// Invariant: `--ui` consumes its value, so a headless flag given as that value
// is not a flag: `--ui --replay` is a server argv with a bad `--ui` value.
test('a headless flag as the value of --ui is not a flag', () => {
  assert.deepEqual(parseEntryArgs(['--ui', '--replay']),
    { kind: 'server_usage', message: "--ui must be one of full | view | interact, got '--replay'" });
  assert.deepEqual(parseEntryArgs(['--ui', '--prompt', 'x']),
    { kind: 'server_usage', message: "--ui must be one of full | view | interact, got '--prompt'" });
});

// Invariant: `--ui` alone never makes a boot headless.
test('--ui alone is an ordinary server', () => {
  assert.equal(parseEntryArgs(['--ui', 'view']).kind, 'server');
  assert.equal(parseEntryArgs(['--ui=full', 'stray']).kind, 'server');
});

// Invariant: a bare `--view` is not a flag (there is no alias): it is an
// ignored unknown argument, so it boots an ordinary `full` server.
test('a bare --view is an ordinary full server', () => {
  assert.deepEqual(parseEntryArgs(['--view']), { kind: 'server', ui: 'full' });
  assert.deepEqual(parseEntryArgs(['--view', '--session', 'x']).kind, 'usage');
});

// Invariant: unknown tokens are ignored beside `--ui` in an ordinary server and
// refused in a headless run (the replay family included).
test('unknown tokens: ignored on a server, refused in a headless run', () => {
  assert.deepEqual(parseEntryArgs(['stray', '--ui', 'view']), { kind: 'server', ui: 'view' });
  assert.deepEqual(parseEntryArgs(['--replay', '--ui', 'interact', 'stray']),
    { kind: 'usage', message: "unexpected argument 'stray' in a headless run", format: 'json' });
});

// Invariant: `--ui` never clashes with `--replay`, which still refuses every run flag.
test('--ui is not a run flag: a replay accepts it', () => {
  assert.equal(parseEntryArgs(['--ui', 'interact', '--replay']).kind, 'replay');
  assert.equal(parseEntryArgs(['--replay', '--ui', 'full', '--mode', 'plan']).message, '--replay cannot be combined with --mode');
});
