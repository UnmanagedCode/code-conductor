// The conductor read nudge (src/conductorReadNudge.ts): a conductor-only
// PreToolUse hook counts project_read/project_bash calls since the last
// delegation and, at the thresholds, answers with an `additionalContext`
// reminder that points at the role doc's gate-decision rule. Pure units over
// the counter, the wording, the matcher, the replay recognizer, the broker's
// nudge path and the settings JSON. The spawned-instance half is in
// tests/hook-callback.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
  ConductorReadNudge, READ_NUDGE_MATCHER, READ_NUDGE_RULE,
  readNudgeText, parseReadNudgeText, readNudgeEvent,
} from '../src/conductorReadNudge.ts';
import { HookBroker } from '../src/hookBroker.ts';
import { replayPersistedLine } from '../src/transcript.ts';
import { buildSettingsJSON, HOOK_HTTP_TIMEOUT_S } from '../src/settings.ts';

const READ = 'mcp__code-conductor__project_read';
const BASH = 'mcp__code-conductor__project_bash';
const DIFF = 'mcp__code-conductor__project_diff';
const SPAWN = 'mcp__code-conductor__spawn_instance';
const SEND = 'mcp__code-conductor__send_prompt';

// Captured from unchanged `main` before src/settings.ts was edited: a worker's
// settings must stay byte-identical.
const GOLDEN_WORKER = '{"hooks":{"PreToolUse":[{"matcher":"Edit|Write|NotebookEdit|Bash","hooks":[{"type":"http","url":"http://h","timeout":660}]}]}}';
const GOLDEN_REDIRECT = '{"hooks":{"PreToolUse":[{"matcher":"Edit|Write|NotebookEdit|Bash|Glob|Grep|Read","hooks":[{"type":"http","url":"http://h","timeout":660}]}],"PostToolUse":[{"matcher":"Edit|Write|NotebookEdit|Bash","hooks":[{"type":"http","url":"http://h","timeout":660}]}]},"permissions":{"deny":["Glob","Grep"]},"includeGitInstructions":false}';

function observeMany(nudge, tool, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(nudge.observe(tool));
  return out;
}

// A minimal express-Response stand-in: records the one body the broker sends.
function fakeRes() {
  return {
    headersSent: false, statusCode: null, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
  };
}

async function post(broker, envelope) {
  const res = fakeRes();
  broker.handle(envelope, res);
  await new Promise(r => setImmediate(r));
  assert.ok(res.headersSent, 'the broker answered the hook');
  return res.body;
}

const envelope = (toolName, toolUseId, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: toolName, tool_use_id: toolUseId, tool_input: {}, ...extra,
});

test('nudges fire exactly at 8 and 16', async (t) => {
  const nudge = new ConductorReadNudge();
  for (let n = 1; n <= 24; n++) {
    const tool = n % 2 ? READ : BASH;
    const r = nudge.observe(tool);
    await t.test(`call ${n} (${tool.slice(-12)})`, () => {
      if (n === 8 || n === 16) {
        assert.ok(r, `call ${n} nudges`);
        assert.equal(r.count, n);
        assert.equal(r.text, readNudgeText(n));
      } else {
        assert.equal(r, null, `call ${n} does not nudge`);
      }
    });
  }
});

test('project_diff is not counted and does not reset', async () => {
  const nudge = new ConductorReadNudge();
  assert.equal(nudge.watches(DIFF), false);
  const broker = new HookBroker({ getRedirect: () => null, readNudge: nudge });
  for (let i = 0; i < 7; i++) assert.deepEqual(await post(broker, envelope(READ, `r${i}`)), {});
  await post(broker, envelope(DIFF, 'd0'));
  const body = await post(broker, envelope(READ, 'r7'));
  assert.equal(body.hookSpecificOutput.additionalContext, readNudgeText(8),
    'the 8th read nudges with count 8: the diff neither counted nor reset the run');
});

for (const [label, tool] of [['spawn_instance', SPAWN], ['send_prompt', SEND]]) {
  test(`${label} resets the run`, () => {
    const nudge = new ConductorReadNudge();
    assert.ok(nudge.watches(tool));
    assert.ok(observeMany(nudge, READ, 7).every(r => r === null));
    assert.equal(nudge.observe(tool), null, 'a delegation never nudges');
    assert.ok(observeMany(nudge, READ, 7).every(r => r === null), 'no nudge before the new run reaches 8');
    assert.equal(nudge.observe(READ)?.count, 8);
  });
}

test('a delegation starts a new run: a later run of 8 in the same turn nudges again', () => {
  const nudge = new ConductorReadNudge();
  const first = observeMany(nudge, BASH, 8);
  assert.equal(first[7]?.count, 8);
  nudge.observe(SEND);
  const second = observeMany(nudge, BASH, 8);
  assert.ok(second.slice(0, 7).every(r => r === null));
  assert.equal(second[7]?.count, 8, 'the second run nudges at its own 8th call');
});

test('reset() starts a new run', () => {
  const nudge = new ConductorReadNudge();
  observeMany(nudge, READ, 7);
  nudge.reset();
  assert.ok(observeMany(nudge, READ, 7).every(r => r === null));
  assert.equal(nudge.observe(READ)?.count, 8);
});

test('wording', () => {
  const t8 = readNudgeText(8);
  assert.ok(t8.includes(READ_NUDGE_RULE), 'points at the rule');
  assert.ok(t8.includes('8'), 'carries the count');
  assert.equal(parseReadNudgeText(readNudgeText(16)), 16);
  assert.equal(parseReadNudgeText('cc probe codeword PLATYPUS-7731.'), null);
  assert.equal(parseReadNudgeText(`prefix ${t8}`), null, 'anchored at the start');
  assert.equal(parseReadNudgeText(`${t8} suffix`), null, 'anchored at the end');
});

test('the referenced role-doc text exists', async () => {
  const core = await fs.readFile(new URL('../conventions/conductor/core.md', import.meta.url), 'utf8');
  assert.ok(core.includes(READ_NUDGE_RULE),
    `conventions/conductor/core.md no longer contains "${READ_NUDGE_RULE}" — the nudge points at text that is gone`);
});

test('matcher', () => {
  // The CLI's own test for a non-plain matcher.
  const re = new RegExp(READ_NUDGE_MATCHER);
  for (const name of [READ, BASH, SPAWN, SEND]) assert.ok(re.test(name), `matches ${name}`);
  for (const name of [DIFF, 'Bash', `${READ}_x`, `x${READ}`, 'project_read']) {
    assert.ok(!re.test(name), `rejects ${name}`);
  }
  assert.ok(!/^[a-zA-Z0-9_|]+$/.test(READ_NUDGE_MATCHER), 'the CLI must treat it as a regex, not a plain list');
});

const attachmentLine = ({ text, hookName = `PreToolUse:${READ}`, hookEvent = 'PreToolUse', toolUseID = 'toolu_n8' }) => ({
  parentUuid: 'p', isSidechain: false, type: 'attachment', uuid: 'att-1',
  attachment: { type: 'hook_additional_context', content: [text], hookName, toolUseID, hookEvent },
});

test('replay recognizer', async (t) => {
  await t.test('our text on a counted tool replays as one read_nudge', () => {
    const evs = replayPersistedLine(attachmentLine({ text: readNudgeText(8) }));
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, 'system');
    assert.equal(evs[0].subtype, 'read_nudge');
    assert.equal(evs[0].toolUseId, 'toolu_n8');
    assert.equal(evs[0].data.count, 8);
    assert.equal(evs[0].data.text, readNudgeText(8));
    assert.equal(evs[0].parentToolUseId, null);
  });
  await t.test('project_bash is recognized too', () => {
    const evs = replayPersistedLine(attachmentLine({ text: readNudgeText(16), hookName: `PreToolUse:${BASH}` }));
    assert.equal(evs.length, 1);
    assert.equal(evs[0].data.tool, BASH);
  });
  await t.test('foreign text on the same hook replays nothing', () => {
    assert.deepEqual(replayPersistedLine(attachmentLine({ text: 'cc probe codeword PLATYPUS-7731.' })), []);
  });
  await t.test('our text on PreToolUse:Bash replays nothing', () => {
    assert.deepEqual(replayPersistedLine(attachmentLine({ text: readNudgeText(8), hookName: 'PreToolUse:Bash' })), []);
  });
  await t.test('our text on a delegation tool replays nothing', () => {
    assert.deepEqual(replayPersistedLine(attachmentLine({ text: readNudgeText(8), hookName: `PreToolUse:${SEND}` })), []);
  });
  await t.test('our text under PostToolUse replays nothing', () => {
    assert.deepEqual(replayPersistedLine(attachmentLine({ text: readNudgeText(8), hookEvent: 'PostToolUse' })), []);
  });
  await t.test('a line without a string toolUseID replays nothing', () => {
    assert.deepEqual(replayPersistedLine(attachmentLine({ text: readNudgeText(8), toolUseID: null })), []);
  });
});

test('live = replay: the broker-emitted event deep-equals the replayed one', async () => {
  const seen = [];
  const nudge = new ConductorReadNudge();
  const broker = new HookBroker({ getRedirect: () => null, readNudge: nudge, onReadNudge: (n) => seen.push(n) });
  for (let i = 1; i <= 8; i++) await post(broker, envelope(BASH, `toolu_${i}`));
  assert.equal(seen.length, 1);
  const live = readNudgeEvent(seen[0]);
  const [replayed] = replayPersistedLine(attachmentLine({
    text: seen[0].text, hookName: `PreToolUse:${BASH}`, toolUseID: 'toolu_8',
  }));
  const { parentToolUseId, ...replayedRest } = replayed;
  assert.equal(parentToolUseId, null);
  assert.deepEqual(live, replayedRest);
});

test('settings: workers byte-identical', () => {
  assert.equal(buildSettingsJSON({ hookCallbackUrl: 'http://h' }), GOLDEN_WORKER);
  assert.equal(buildSettingsJSON({ hookCallbackUrl: 'http://h', redirect: true }), GOLDEN_REDIRECT);
  assert.equal(buildSettingsJSON({ hookCallbackUrl: 'http://h', conductor: false }), GOLDEN_WORKER);
  assert.equal(buildSettingsJSON({ hookCallbackUrl: 'http://h', redirect: true, conductor: false }), GOLDEN_REDIRECT);
});

test('settings: conductor entry', () => {
  const worker = JSON.parse(GOLDEN_WORKER);
  const s = JSON.parse(buildSettingsJSON({ hookCallbackUrl: 'http://h', conductor: true }));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(s.hooks.PreToolUse[0], worker.hooks.PreToolUse[0], 'the base entry is unchanged');
  assert.deepEqual(s.hooks.PreToolUse[1], {
    matcher: READ_NUDGE_MATCHER,
    hooks: [{ type: 'http', url: 'http://h', timeout: HOOK_HTTP_TIMEOUT_S }],
  });
  assert.equal(s.hooks.PostToolUse, undefined);
  assert.equal(s.permissions, undefined);
  assert.deepEqual(JSON.parse(buildSettingsJSON({ conductor: true })), { hooks: { PreToolUse: [] } },
    'no URL, no hooks at all');
});
