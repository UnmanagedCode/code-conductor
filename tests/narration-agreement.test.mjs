// LIVE AND RELOAD AGREE ON NARRATION. For each real fixture pair under
// tests/fixtures/narration/ (`<case>.stdout.jsonl` = the CLI's stdout for whole
// messages, `<case>.transcript.jsonl` = what the CLI persisted for the same
// message ids), every classifying surface finds the SAME narration:
//   - the live parser (thinking_delta events flagged `narration: true`),
//   - transcript replay (loadPersistedTranscript over the seeded jsonl),
//   - get_recent_messages' reconstruction, over the coalesced ring with the
//     assistant envelopes (reconciled arm), without them (delta arm), and over
//     the disk events.
// Each is pinned to a literal per case, so agreement cannot pass by every
// surface being wrong the same way.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '../src/parser.ts';
import { loadPersistedTranscript } from '../src/transcript.ts';
import { reconstructMessages } from '../src/mcp/messageReconstruction.ts';
import { stampArchiveEvents } from '../src/eventArchive.ts';
import { EventLog } from '../src/instances.ts';
import { isNarration } from '../src/narration.ts';
import { localPlace } from '../src/projects.ts';
import { freshProjectsRoot, seedSessionJsonl, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'narration');

const NARRATION_MSG = 'msg_011Cg4aZkEcqTrXhBFw7EJnj';
const NARRATION_TEXT = "This is fixable: I'll have the server save the instruction text (not the cut-off frame) as the session's first-prompt preview when the first prompt is a forward, update `readablePrompt`/`promptPreview` to show its first line (falling back to \"Forwarded worker output\" when missing), and adjust the related tests and docs—also noting that generic instruction openers should be replaced with role lines so titles stay meaningful.\n\n";

// Per case: the narration blocks as `msgId:blockIdx` → text, and the
// reconstructed `narration` per msgId (blocks trimmed, joined by a blank line).
const EXPECTED = {
  'claude-narration': {
    blocks: { [`${NARRATION_MSG}:1`]: NARRATION_TEXT },
    recon: { [NARRATION_MSG]: NARRATION_TEXT.trim() },
  },
  'claude-redacted-only': { blocks: {}, recon: {} },
  'deepseek-plain': { blocks: {}, recon: {} },
};

let home;
before(async () => { ({ home } = await freshProjectsRoot()); });
after(async () => { await rmrf(home); });

const readJsonl = async (f) => (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));

function liveEvents(stdoutLines) {
  const parser = new Parser();
  return stdoutLines.flatMap(l => parser.handleObject(l));
}

// msgId:blockIdx → concatenated text of every narration-flagged thinking_delta.
function flaggedBlocks(events) {
  const out = {};
  for (const ev of events) {
    if (ev.kind !== 'thinking_delta' || !ev.narration) continue;
    const k = `${ev.msgId}:${ev.blockIdx}`;
    out[k] = (out[k] ?? '') + ev.text;
  }
  return out;
}

// Push events through the instance ring (fresh object per push, as the parser
// emits them) and return what it retained.
function ring(events) {
  const log = new EventLog({ cap: 100000 });
  for (const ev of events) log.push({ ...ev });
  return log.buf;
}

const narrationByMsg = (messages) =>
  Object.fromEntries(messages.filter(m => m.narration !== undefined).map(m => [m.msgId, m.narration]));

async function diskEvents(name, transcriptLines) {
  const place = localPlace(`/workspace/narration-${name}`);
  const sessionId = `00000000-0000-4000-8000-${String(Object.keys(EXPECTED).indexOf(name)).padStart(12, '0')}`;
  await seedSessionJsonl(place, sessionId, transcriptLines);
  const result = await loadPersistedTranscript({ place, sessionId });
  assert.ok(result, 'the seeded transcript loads');
  return stampArchiveEvents(result.lines);
}

test('every fixture pair: live, reload and both reconstruction arms find the same narration', async (t) => {
  const cases = (await fs.readdir(FIXTURES)).filter(f => f.endsWith('.stdout.jsonl')).map(f => f.replace('.stdout.jsonl', ''));
  assert.deepEqual(cases.sort(), Object.keys(EXPECTED).sort(), 'every fixture pair has a pinned expectation');
  for (const name of cases) {
    await t.test(name, async (t) => {
      const stdout = await readJsonl(path.join(FIXTURES, `${name}.stdout.jsonl`));
      const live = liveEvents(stdout);
      const disk = await diskEvents(name, await readJsonl(path.join(FIXTURES, `${name}.transcript.jsonl`)));
      const want = EXPECTED[name];

      await t.test('live parser', () => assert.deepEqual(flaggedBlocks(live), want.blocks));
      await t.test('transcript replay', () => assert.deepEqual(flaggedBlocks(disk), want.blocks));
      await t.test('reconstruction, reconciled arm (ring with envelopes)', () =>
        assert.deepEqual(narrationByMsg(reconstructMessages(ring(live), false)), want.recon));
      await t.test('reconstruction, delta arm (ring without envelopes)', () =>
        assert.deepEqual(narrationByMsg(reconstructMessages(ring(live.filter(e => e.kind !== 'assistant_message')), false)), want.recon));
      await t.test('reconstruction, disk events', () =>
        assert.deepEqual(narrationByMsg(reconstructMessages(disk, false)), want.recon));
    });
  }
});

test('deepseek-plain: readable thinking stays plain thinking on every surface', async () => {
  const live = liveEvents(await readJsonl(path.join(FIXTURES, 'deepseek-plain.stdout.jsonl')));
  const deltas = live.filter(e => e.kind === 'thinking_delta');
  assert.ok(deltas.length > 0, 'the fixture streams thinking');
  assert.equal(deltas.filter(e => 'narration' in e).length, 0, 'no thinking_delta carries the narration flag');
  const recon = reconstructMessages(ring(live), true);
  assert.ok(recon.some(m => m.blocks?.some(b => b.type === 'thinking' && b.text)), 'includeThinking still lists its thinking');
});

// The CLI's undocumented `narration_block_indexes` envelope field is never
// read by src/. Here it is an early warning only: if Claude's block ordering
// drifts from the rule, the fixture's own field disagrees with the verdict.
test('drift check: narration_block_indexes on each stdout envelope agrees with the rule', async (t) => {
  for (const name of Object.keys(EXPECTED)) {
    await t.test(name, async () => {
      const prevByMsg = new Map();
      let envelopes = 0;
      for (const line of await readJsonl(path.join(FIXTURES, `${name}.stdout.jsonl`))) {
        if (line.type !== 'assistant') continue;
        const content = line.message.content;
        const flagged = new Set(line.narration_block_indexes ?? []);
        content.forEach((b, i) => {
          const probe = { type: b.type, text: b.type === 'thinking' ? b.thinking : (b.text ?? '') };
          const verdict = isNarration(prevByMsg.get(line.message.id), probe);
          assert.equal(flagged.has(i), verdict, `${line.message.id} block ${i}: field says ${flagged.has(i)}, rule says ${verdict}`);
          prevByMsg.set(line.message.id, probe);
          envelopes++;
        });
      }
      assert.ok(envelopes > 0, 'the fixture carries assistant envelopes');
    });
  }
});

test('ring: a narration block coalesces into one retained slot that keeps the flag', async () => {
  const live = liveEvents(await readJsonl(path.join(FIXTURES, 'claude-narration.stdout.jsonl')));
  const liveFlagged = live.filter(e => e.kind === 'thinking_delta' && e.narration);
  assert.ok(liveFlagged.length > 1, 'the live stream carries the flag on every delta of the block');
  assert.equal(live.filter(e => e.kind === 'thinking_delta' && e.msgId === NARRATION_MSG && e.blockIdx === 1 && !e.narration).length, 0,
    'no delta of the narration block is unflagged');
  const slots = ring(live).filter(e => e.kind === 'thinking_delta' && e.msgId === NARRATION_MSG && e.blockIdx === 1);
  assert.equal(slots.length, 1, 'one coalesced slot');
  assert.equal(slots[0].narration, true);
  assert.equal(slots[0].text, NARRATION_TEXT);
});
