// THE CLI-CONTRACT REGRESSION TEST for the conductor read nudge
// (src/conductorReadNudge.ts). Skipped by default — opt in with
// `RUN_CLI_CONTRACT=1`:
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/conductor-read-nudge-cli.real.test.mjs
//
// The nudge rests on two undocumented Claude Code behaviours, and a CLI upgrade
// that changed either would break it silently:
//   * A PreToolUse reply carrying `additionalContext` and NO `permissionDecision`
//     is delivered, and persisted to the session jsonl as a
//     `hook_additional_context` attachment whose `toolUseID` is the envelope's
//     `tool_use_id` — the replay source and the archive correlation identity.
//   * A matcher outside `^[a-zA-Z0-9_|]+$` is applied as a regex, so the
//     conductor's anchored matcher fires on exactly its tools.
//
// Harness and the two rules every case follows: tests/cliContractCase.mjs.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeCwd } from '../src/projects.ts';
import { fixture, hookServer, runClaude, settingsJSON, t } from './cliContractCase.mjs';

const MARKER = 'cc read-nudge probe codeword OCELOT-4417.';
const PROMPT = 'Run the Bash command `echo hello`, then reply with the single word DONE.';
const ANCHORED = '^(Bash|NoSuchTool)$';

async function jsonl(cwd, sessionId) {
  const root = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const file = path.join(root, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
  const out = [];
  for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is not evidence either way */ }
  }
  return out;
}

const attachments = async (cwd, sessionId) => (await jsonl(cwd, sessionId))
  .filter(o => o.type === 'attachment' && o.attachment?.type === 'hook_additional_context')
  .map(o => o.attachment);

const calledBash = async (cwd, sessionId) => (await jsonl(cwd, sessionId)).some(o => o.type === 'assistant'
  && Array.isArray(o.message?.content) && o.message.content.some(b => b?.type === 'tool_use' && b.name === 'Bash'));

// PINS: an `additionalContext`-only PreToolUse reply lands in the jsonl as a
// `hook_additional_context` attachment keyed by the envelope's tool_use_id, and
// an anchored-regex matcher fires for the tool it names. CONTROL: a `{}` reply
// under the same matcher persists no attachment.
t('an additionalContext-only PreToolUse reply persists a hook_additional_context attachment keyed by tool_use_id', async () => {
  const { dir, clean } = await fixture();
  const hooks = await hookServer((e) => (
    e.tool_name === 'Bash' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: MARKER } } : {}
  ));
  try {
    const frame = await runClaude(dir, settingsJSON(hooks.url, { pre: [ANCHORED] }), PROMPT);
    const pre = hooks.of('PreToolUse', 'Bash');
    assert.ok(pre.length >= 1, 'the anchored-regex matcher fired for Bash');
    // Selected by the envelope's id, not by content, so a changed content shape
    // fails the shape assertion below rather than vanishing from the filter.
    const atts = (await attachments(dir, frame.session_id)).filter(a => a.toolUseID === pre[0].tool_use_id);
    assert.ok(atts.length >= 1, 'the reply was persisted as a hook_additional_context attachment keyed by the envelope\'s tool_use_id');
    assert.equal(atts[0].hookEvent, 'PreToolUse');
    assert.equal(atts[0].hookName, 'PreToolUse:Bash');
    // The shape readNudgeEventFromAttachment depends on: an ARRAY of strings,
    // one of which is the hook's additionalContext verbatim. A bare string here
    // would leave the read nudge unreplayable.
    assert.ok(Array.isArray(atts[0].content), `content is ${typeof atts[0].content}, not an array — replay would drop the nudge`);
    assert.ok(atts[0].content.some(c => c === MARKER), 'one content element is the additionalContext string, verbatim');
  } finally { await hooks.close(); await clean(); }

  const { dir: dir2, clean: clean2 } = await fixture();
  const ctl = await hookServer(() => ({}));
  try {
    const frame = await runClaude(dir2, settingsJSON(ctl.url, { pre: [ANCHORED] }), PROMPT);
    assert.ok(ctl.of('PreToolUse', 'Bash').length >= 1, 'the control fired the hook');
    assert.equal((await attachments(dir2, frame.session_id)).length, 0, 'a {} reply persists no attachment');
  } finally { await ctl.close(); await clean2(); }
});

// PINS: an anchored regex that does not name the tool does not fire — the
// positive half above is attributable to the regex, not to a matcher the CLI
// ignores.
t('an anchored-regex matcher that does not name the tool does not fire', async () => {
  const { dir, clean } = await fixture();
  const hooks = await hookServer(() => ({}));
  try {
    const frame = await runClaude(dir, settingsJSON(hooks.url, { pre: ['^(NoSuchTool)$'] }), PROMPT);
    assert.ok(await calledBash(dir, frame.session_id), 'fixture check: the model did call Bash');
    assert.equal(hooks.seen.length, 0, `the hook fired ${hooks.seen.length} times for a matcher naming no called tool`);
  } finally { await hooks.close(); await clean(); }
});
