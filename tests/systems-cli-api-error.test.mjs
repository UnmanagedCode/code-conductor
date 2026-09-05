// The only part of the gated CLI-contract family the ORDINARY suite executes.
//
// tests/run.mjs discovers `*.test.mjs`, and every case in
// tests/systems-cli-*.real.test.mjs is registered through a gate on
// `RUN_CLI_CONTRACT=1` that neither `npm test` nor `npm run gate:systems` ever
// sets. So the endpoint scrub, the session guard and the detach poll are all
// invisible to both runs and to the mutation driver with them. What IS
// decidable with no CLI and no network is the discriminator every one of them
// keys on, and that is the whole subject of this file.
//
// WHY THE DISCRIMINATOR NEEDS PINNING AT ALL. A CLI that never reached the API
// still returns a well-formed `result` frame, and the two fields an editor
// would reach for first both lie about it: `subtype` reads "success" on the
// error frame, and `is_error` reads true on a legitimate interrupt that the
// gated case `an interrupt kills the forwarder and aborts its in-flight
// request` depends on succeeding. Keying on the wrong one either misses the
// error — 90s of bounded waits and a hang-guard SIGKILL — or turns a green case
// red.
//
// EVERY FILE FIXTURE IS A CAPTURED FRAME, BYTE FOR BYTE, from `claude` CLI
// 2.1.258 on node v24.18.0 (card 2026-0321 §1e); each case names the condition
// that produced its own. A fixture is a claim about its producer, so a CLI
// release that moves the field is MEANT to red these rather than to slip past.
// The ONE case built on hand-written frames instead is fenced and labelled
// SYNTHETIC below, and says why the captures cannot do its job.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiErrorReason } from './cliContractCase.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const frame = async (name) =>
  JSON.parse(await fs.readFile(path.join(FIXTURES, `cli-result-${name}.json`), 'utf8'));

// Captured with `ANTHROPIC_BASE_URL` pointed at a local backend that does not
// serve the pinned model.
test('a 404 frame is diagnosed with its status AND the CLI\'s own words', async () => {
  const f = await frame('404');
  const why = apiErrorReason(f);
  assert.equal(typeof why, 'string', `a 404 frame is an api error (got ${why})`);
  assert.ok(why.includes(String(f.api_error_status)),
    `the diagnosis names the status (${why})`);
  // Relaying the CLI's own sentence is the point: the harness's alternative
  // top-line message blames the hook, which sends a reviewer to the wrong file.
  assert.ok(why.includes(f.result), `the diagnosis relays the CLI's reason (${why})`);
});

// Captured with a bogus `ANTHROPIC_API_KEY` and NO base-URL override — a
// second, different status, so nothing here can pass by hard-coding the first.
test('a 401 frame is diagnosed with ITS status, not the other fixture\'s', async () => {
  const f = await frame('401');
  const why = apiErrorReason(f);
  assert.equal(typeof why, 'string', `a 401 frame is an api error (got ${why})`);
  assert.ok(why.includes('401'), `the diagnosis names 401 (${why})`);
  assert.ok(!why.includes('404'), `and not the 404 fixture's status (${why})`);
  assert.ok(why.includes(f.result), `the diagnosis relays the CLI's reason (${why})`);
});

// Captured from cc's own interrupt channel, a `control_request` with
// `{subtype:'interrupt'}`. THE ANTI-REGRESSION: this frame is what an
// `is_error` guard would misread, and it is also the one with no `result` key
// at all, so a diagnosis built by assuming that key would throw here.
test('an interrupted turn is NOT an api error, though is_error is true', async () => {
  const f = await frame('interrupt');
  assert.equal(f.is_error, true, 'the fixture still carries the trap it exists to disarm');
  assert.equal('result' in f, false, 'and still carries no result text');
  assert.equal(apiErrorReason(f), null);
});

// ============================== SYNTHETIC ==============================
// THE TWO FRAMES BELOW WERE HAND-BUILT AND ARE NOT SHAPES THE CLI HAS BEEN
// OBSERVED TO EMIT. Every other frame in this file is a verbatim capture and
// therefore a claim about its producer; these two are not, and must never be
// read as one.
//
// They exist because the captures cannot do this job. On all four of them
// `api_error_status != null` and `terminal_reason === 'api_error'` agree
// exactly — 404 and 401 carry `"api_error"`, the interrupt carries
// `"aborted_streaming"`, the healthy one `"completed"`. Two different
// implementations of `apiErrorReason` therefore pass every captured case
// identically, and WHICH KEY IS READ is the whole invariant the guard rests on:
// `terminal_reason` is CLI prose about how the turn ended, while
// `api_error_status` is the transport answer, and only the second is what the
// harness needs to know. So these frames are constructed to make the two
// predicates disagree, in both directions, and nothing more.
test('the diagnosis reads api_error_status, not terminal_reason', () => {
  const statusOnly = { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'completed', api_error_status: 503, result: 'upstream said no' };
  const why = apiErrorReason(statusOnly);
  assert.equal(typeof why, 'string', `a status with no api_error terminal_reason is still an api error (got ${why})`);
  assert.ok(why.includes('503'), `and is diagnosed with that status (${why})`);

  const reasonOnly = { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'no transport status here' };
  assert.equal(apiErrorReason(reasonOnly), null,
    'and terminal_reason alone, with no status, is not one');
});
// ============================ END SYNTHETIC ============================

// Captured with no overrides at all.
test('a healthy frame and a 404 frame are indistinguishable by subtype', async () => {
  const ok = await frame('healthy');
  const bad = await frame('404');
  assert.equal(ok.subtype, bad.subtype,
    'the second trap: subtype cannot separate a healthy run from an api error');
  assert.equal(apiErrorReason(ok), null);
  assert.equal(typeof apiErrorReason(bad), 'string');
});
