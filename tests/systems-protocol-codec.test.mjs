// The NDJSON codec and the error taxonomy, at the unit level.
//
// The codec is the one piece BOTH ends of the protocol share, so a bug here is
// a bug in every provider anyone ever writes. The behaviour that matters is not
// "it parses valid frames" — it is what it does with the invalid ones, because
// that is where a channel either fails loudly or starts answering questions
// from a stream it has already proved it cannot read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FS_ERROR_CODES, MAX_LINE_BYTES, NO_CAPABILITIES, NdjsonDecoder, PROTOCOL_ERROR_CODES, PROTOCOL_VERSION,
  SystemError, classifySpawnError, classifyStderr, decodeFrame, encodeFrame, execFailure,
  isBase64, isSystemErrorCode, readCapabilities,
} from '../src/systems/protocol.ts';

const push = (dec, s) => dec.push(Buffer.from(s, 'utf8'));

test('a frame round-trips, and one chunk may carry several', () => {
  const dec = new NdjsonDecoder();
  const line = encodeFrame({ type: 'exec', id: 'e1', cwd: '/tmp', argv: ['echo', 'hi'] });
  assert.equal(line.endsWith('\n'), true, 'every frame is newline-terminated');
  assert.equal(line.includes('\n'), true);
  const frames = push(dec, line + encodeFrame({ type: 'end', id: 'e1' }));
  assert.deepEqual(frames.map(f => f.type), ['exec', 'end']);
  assert.deepEqual(frames[0].argv, ['echo', 'hi']);
});

test('a frame split across chunks is held until its newline arrives', () => {
  const dec = new NdjsonDecoder();
  assert.deepEqual(push(dec, '{"type":"exi'), [], 'a partial line yields nothing');
  assert.ok(dec.pending > 0, 'the partial line is held, not dropped');
  const frames = push(dec, 't","id":"e1","code":0}\n');
  assert.deepEqual(frames.map(f => f.type), ['exit']);
  assert.equal(dec.pending, 0);
});

test('a multi-byte character split across a chunk boundary still decodes', () => {
  // The split point is found on RAW BYTES, which is only safe because 0x0A
  // cannot occur inside a UTF-8 multi-byte sequence — decoding per chunk would
  // turn this into two replacement characters.
  const dec = new NdjsonDecoder();
  const bytes = Buffer.from(encodeFrame({ type: 'stdout', id: 'e1', seq: 0, dataB64: '', note: 'héllo — ✓' }), 'utf8');
  const cut = Math.floor(bytes.length / 2);
  assert.deepEqual(dec.push(bytes.subarray(0, cut)), []);
  const frames = dec.push(bytes.subarray(cut));
  assert.equal(frames[0].note, 'héllo — ✓');
});

test('blank lines between frames are whitespace, not frames and not errors', () => {
  const dec = new NdjsonDecoder();
  const frames = push(dec, `\n\r\n${encodeFrame({ type: 'end', id: 'x' })}\n`);
  assert.deepEqual(frames.map(f => f.type), ['end']);
});

test('a malformed line is FATAL — EPROTO, and the buffer is dropped', () => {
  // Not skipped: a stream that has proved it cannot be framed cannot be trusted
  // for anything later on it either.
  const dec = new NdjsonDecoder();
  assert.throws(() => push(dec, 'this is not json\n'), (e) => e instanceof SystemError && e.code === 'EPROTO');
  assert.equal(dec.pending, 0, 'the unparseable buffer is dropped, not carried into the next push');
});

test('a JSON value that is not an object, and an object with no type, are EPROTO', () => {
  for (const bad of ['[1,2,3]', '"a string"', '42', 'null', '{"id":"e1"}', '{"type":"","id":"e1"}', '{"type":7}']) {
    assert.throws(() => decodeFrame(bad), (e) => e instanceof SystemError && e.code === 'EPROTO', bad);
  }
});

test('an unknown frame type decodes fine — that is the extension point', () => {
  // Unknown types are ignored by both ends, which is how the contract grows
  // without a protocol version bump.
  const f = decodeFrame('{"type":"somethingNew","id":"x","extra":1}');
  assert.equal(f.type, 'somethingNew');
  assert.equal(f.extra, 1);
  // …and the payload rule does NOT reach it. The rule is keyed on the four
  // frame types whose meaning IS their payload; a future type may carry a
  // `dataB64` cc knows nothing about, and rejecting it would close the
  // extension point the line above opens.
  const g = decodeFrame('{"type":"somethingNew","id":"x","dataB64":"!!not base64"}');
  assert.equal(g.dataB64, '!!not base64');
  // Nor does it reach a KNOWN type that carries no payload.
  assert.equal(decodeFrame('{"type":"exit","id":"x","code":0,"dataB64":"!!"}').code, 0);
});

test('canonical base64 is what isBase64 accepts, and nothing else', () => {
  for (const good of ['', 'AAAA', 'SEVMTE8=', 'SEVMTE9P', 'YQ==']) {
    assert.equal(isBase64(good), true, JSON.stringify(good));
  }
  for (const bad of [
    'SEVMTE8',        // length not a multiple of 4
    '!!!!',           // outside the alphabet
    'AB=C',           // padding that is not at the end
    'SEVM TE8=',      // whitespace
    'SEVMTE8===',     // over-padded
    'SEVMTE8=!!junk', // the shape that matters: a valid prefix then garbage,
                      // which a lenient decoder returns the prefix of
  ]) {
    assert.equal(isBase64(bad), false, JSON.stringify(bad));
  }
});

test('a payload frame with a corrupted or missing dataB64 is EPROTO — on every payload type', () => {
  // A payload is part of its frame. `Buffer.from(s,'base64')` stops at the first
  // unreadable character and returns the prefix, so decoding leniently turns a
  // corrupted chunk into a SILENT PARTIAL ANSWER: a writeFile that reports
  // success having dropped its tail, or a command whose stdout is quietly
  // truncated with exit 0. Checked here, once, for both ends and both
  // directions — `stdout`/`stderr`/`data` come from the provider, `data` goes to
  // it.
  for (const type of ['stdout', 'stderr', 'data']) {
    assert.throws(
      () => decodeFrame(`{"type":"${type}","id":"x","seq":0,"dataB64":"SEVMTE8=!!corrupted"}`),
      (e) => e instanceof SystemError && e.code === 'EPROTO' && /invalid base64/.test(e.message),
      `${type}: a corrupted payload`,
    );
    assert.throws(
      () => decodeFrame(`{"type":"${type}","id":"x","seq":0}`),
      (e) => e instanceof SystemError && e.code === 'EPROTO' && /no dataB64/.test(e.message),
      `${type}: an absent payload`,
    );
    assert.throws(
      () => decodeFrame(`{"type":"${type}","id":"x","seq":0,"dataB64":null}`),
      (e) => e.code === 'EPROTO',
      `${type}: a non-string payload`,
    );
    // A zero-byte payload is legitimate — an empty chunk, or a zero-length read.
    assert.equal(decodeFrame(`{"type":"${type}","id":"x","seq":0,"dataB64":""}`).dataB64, '');
  }
});

test('a spawn failure names its errno as a TOKEN, not as strerror text', () => {
  // `spawn /bin/sh ENOENT` carries no 'No such file or directory', so the
  // stderr classifier cannot read it — which is why a command that never
  // started gets its own reader. A vanished cwd depends on this being ENOENT
  // rather than an opaque failure.
  assert.equal(classifySpawnError('spawn /bin/sh ENOENT'), 'ENOENT');
  assert.equal(classifySpawnError('spawn EACCES'), 'EACCES');
  assert.equal(classifySpawnError('Error: spawn ENOTDIR'), 'ENOTDIR');
  assert.equal(classifySpawnError('something nobody has seen before'), 'EUNKNOWN');
  // THE BOUNDARY RULE, which only a message carrying an unknown code that
  // CONTAINS a known one can show: a plain substring search would answer EACCES
  // for both of these, naming a permissions fault that did not happen and
  // hiding the real one.
  assert.equal(classifySpawnError('spawn /x EACCESX'), 'EUNKNOWN', 'a longer code is not EACCES');
  assert.equal(classifySpawnError('spawn /x XEACCES'), 'EUNKNOWN', 'nor is a suffixed one');
  assert.equal(classifySpawnError('spawn /x ENOENTFOO'), 'EUNKNOWN');
  // Adjacent punctuation is still a boundary — the errno is a whole word, not a
  // whole message.
  assert.equal(classifySpawnError("spawn '/x': ENOENT."), 'ENOENT');
});

test('a line past the framing fence is EPROTO, even before its newline arrives', () => {
  const dec = new NdjsonDecoder({ maxLineBytes: 64 });
  assert.throws(() => push(dec, 'x'.repeat(65) + '\n'), (e) => e.code === 'EPROTO');
  const dec2 = new NdjsonDecoder({ maxLineBytes: 64 });
  // No newline at all: an endless line must be caught by the fence rather than
  // buffered forever.
  assert.throws(() => push(dec2, 'x'.repeat(65)), (e) => e.code === 'EPROTO');
  assert.equal(MAX_LINE_BYTES > 0, true);
});

test('classifyStderr maps every well-known message, and nothing else', () => {
  assert.equal(classifyStderr("stat: cannot statx '/nope': No such file or directory"), 'ENOENT');
  assert.equal(classifyStderr("cat: ro: Permission denied"), 'EACCES');
  assert.equal(classifyStderr("mkdir: cannot create directory 'd': File exists"), 'EEXIST');
  assert.equal(classifyStderr("bfs: error: '/tmp/f/.': Not a directory."), 'ENOTDIR');
  assert.equal(classifyStderr("cat: /tmp: Is a directory"), 'EISDIR');
  assert.equal(classifyStderr("cp: error writing 'x': No space left on device"), 'ENOSPC');
  assert.equal(classifyStderr('something nobody has seen before'), 'EUNKNOWN',
    'an unmatched failure is EUNKNOWN — cc never guesses at a message it does not know');
  assert.equal(classifyStderr(''), 'EUNKNOWN');
});

test('an unmatched failure carries its exit code and its RAW stderr, verbatim', () => {
  const e = execFailure("stat '/x'", 3, 'weird tool said no\n');
  assert.equal(e.code, 'EUNKNOWN');
  assert.equal(e.exitCode, 3);
  assert.equal(e.stderr, 'weird tool said no\n');
  assert.match(e.message, /weird tool said no/, 'the raw text reaches the user, not a tidy summary');
});

test('capability negotiation: a missing key is false, an unknown key is ignored', () => {
  assert.deepEqual(readCapabilities(undefined), NO_CAPABILITIES);
  assert.deepEqual(readCapabilities({ processGroupSignal: true, somethingFuture: true }),
    { ...NO_CAPABILITIES, processGroupSignal: true });
  assert.deepEqual(readCapabilities({ remotes: true }), { ...NO_CAPABILITIES, remotes: true },
    'a system that serves many targets says so, and says nothing else');
  assert.deepEqual(readCapabilities({ processGroupSignal: 'yes' }), NO_CAPABILITIES,
    'only a literal true enables a capability');
});

// PINS THE DECODE HALF of the rule card 2026-0312's descriptor deletion rests
// on: an unknown FIELD on a KNOWN frame survives decoding untouched rather than
// being rejected. Separate from the unknown-capability-key and unknown-frame-type
// rules — this one is about a frame cc fully understands carrying more than cc
// reads, which is every pre-0312 provider's hello.
//
// NOT CLAIMING that anything downstream reads the field; the handshake half is
// tests/systems-provider-supervision.test.mjs's.
test('an unknown field on a KNOWN frame decodes, it is not refused', () => {
  const f = decodeFrame(JSON.stringify({
    type: 'hello', protocol: 1, provider: 'legacy/0.1.0',
    capabilities: { processGroupSignal: true },
    system: { os: 'linux', pathSep: '/', shell: '/bin/bash', home: '/root' },
    somethingCcHasNeverHeardOf: { nested: [1, 2, 3] },
  }));
  assert.equal(f.type, 'hello');
  assert.equal(f.provider, 'legacy/0.1.0');
  assert.deepEqual(f.system, { os: 'linux', pathSep: '/', shell: '/bin/bash', home: '/root' },
    'the deleted descriptor rides through the decoder untouched');
  assert.deepEqual(f.somethingCcHasNeverHeardOf, { nested: [1, 2, 3] });
});

test('the taxonomy is closed: every named code is recognised and nothing else is', () => {
  for (const c of [...PROTOCOL_ERROR_CODES, ...FS_ERROR_CODES]) assert.equal(isSystemErrorCode(c), true, c);
  for (const c of ['EWHATEVER', '', null, 7]) assert.equal(isSystemErrorCode(c), false, String(c));
  assert.equal(PROTOCOL_VERSION, 1);
});

// PINS §8's protocol-level table against PROTOCOL_ERROR_CODES. Doc bytes are an
// INPUT here: §8's heading text and its `| `ECODE` |` row format are load-bearing,
// and renaming or reformatting either reds this test. That is the accepted cost.
//
// DO NOT move this into tests/systems-protocol-conformance.test.mjs. §10 of the
// doc sells that battery to third parties as "YOUR provider, same battery, no
// test edits"; they clone it without our docs, so a test in it that opens
// docs/systems-protocol.md is broken for exactly that audience.
test('§8 of docs/systems-protocol.md names exactly PROTOCOL_ERROR_CODES', () => {
  const doc = readFileSync(new URL('../docs/systems-protocol.md', import.meta.url), 'utf8');
  const start = doc.indexOf('### Protocol-level');
  // End at the next heading of `##` depth or deeper, so a restructure that changes
  // §8's successor level reds here instead of silently swallowing the FS-code table
  // below. The `##` floor is load-bearing: a bare `#` would also match the shell
  // comments inside this doc's own fenced blocks.
  const after = start === -1 ? -1 : doc.slice(start + 1).search(/\n#{2,} /);
  const end = after === -1 ? -1 : start + 1 + after;
  assert.ok(start !== -1 && end > start,
    'could not locate §8 protocol-level block in docs/systems-protocol.md — re-anchor this test');
  const listed = [...doc.slice(start, end).matchAll(/^\| `(E[A-Z]+)`/gm)].map((m) => m[1]);
  assert.ok(listed.length > 0, 'located the §8 block but parsed no code rows — re-anchor the row regex');
  const missing = PROTOCOL_ERROR_CODES.filter((c) => !listed.includes(c));
  const extra = listed.filter((c) => !PROTOCOL_ERROR_CODES.includes(c));
  assert.deepEqual(missing, [], `in PROTOCOL_ERROR_CODES but missing from §8's table: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `in §8's table but not in PROTOCOL_ERROR_CODES: ${extra.join(', ')}`);
});
