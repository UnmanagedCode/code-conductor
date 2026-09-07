// The hook plumbing redirection needs: what the injected settings ask the CLI
// for, and what the broker answers.
//
// Two things are new here and both are load-bearing. The broker used to speak
// only allow/deny on PreToolUse; it now also carries `updatedInput` (the Bash
// rewrite) and answers PostToolUse with `additionalContext` (the write-back
// note). And the ask card must render the command the WORKER asked for, not the
// forwarder invocation it was rewritten into — under redirection every Bash
// call looks alike to the permission layer, so a card built from the post-hook
// input would show every command as the same opaque line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookBroker } from '../src/hookBroker.ts';
import { buildSettingsJSON } from '../src/settings.ts';
import { FILE_TOOLS } from '../src/systems/toolRedirect.ts';

function fakeRes() {
  const res = {
    headersSent: false, statusCode: 0, body: null,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; res.headersSent = true; return res; },
  };
  return res;
}

const settled = (res) => new Promise((r) => {
  const tick = () => (res.headersSent ? r(res) : setTimeout(tick, 1));
  tick();
});

function broker({ mode = 'bypassPermissions', redirect = null } = {}) {
  const events = [];
  const b = new HookBroker({
    getMode: () => mode,
    emit: (ev) => events.push(ev),
    getRedirect: () => redirect,
  });
  return { b, events };
}

const envelope = (over = {}) => ({
  hook_event_name: 'PreToolUse', tool_use_id: 'tu1', tool_name: 'Bash',
  tool_input: { command: 'npm test' }, ...over,
});

// PINS: without redirection the injected settings are what they were — no
// PostToolUse hook, no permissions block, Read ungated. Every local project in
// the install runs through this function, so a change here that leaked to them
// would start prompting on reads.
test('a non-redirected session gets the settings it always got', () => {
  const s = JSON.parse(buildSettingsJSON({ hookCallbackUrl: 'http://h' }));
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Edit|Write|NotebookEdit|Bash');
  assert.equal(s.hooks.PostToolUse, undefined);
  assert.equal(s.permissions, undefined);
});

// PINS: a redirected session HOOKS Read, still registers PostToolUse (no
// consumer today; S3's write-back needs the seam), and REMOVES Glob and Grep,
// because a marked CLI's Grep spawns an unmarked `rg` that would search the
// wrong side and return silently wrong results.
//
// DELIBERATELY INVERTED FROM S1, which asserted Read was NOT hooked. S1's
// reason held for the hook Read used to have — a PreToolUse pull the union made
// unnecessary. S2 gives it a different job (criterion 11): a Read aimed at a
// path the union does not serve to this session has to meet cc's refusal rather
// than an -ENOENT the model reads as "the file is absent". The clause that
// mattered in S1 survives as A14 below — hooked, and still not gated.
//
// A15: EVERY FILE_TOOLS KEY IS IN THE MATCHER, enumerated from the exported map
// rather than transcribed, so a fifth file tool declared without being hooked
// fails here instead of silently escaping the boundary.
test('a redirected session hooks every file tool, keeps PostToolUse, and removes Glob/Grep', () => {
  const s = JSON.parse(buildSettingsJSON({ hookCallbackUrl: 'http://h', redirect: true }));
  for (const tool of Object.keys(FILE_TOOLS)) {
    assert.match(s.hooks.PreToolUse[0].matcher, new RegExp(`\\b${tool}\\b`), `${tool} is not hooked`);
  }
  assert.match(s.hooks.PreToolUse[0].matcher, /\bBash\b/);
  assert.equal(s.hooks.PostToolUse[0].hooks[0].url, 'http://h');
  assert.deepEqual(s.permissions.deny, ['Glob', 'Grep']);
  // And hooked as well as denied — two independent guards, because the CLI's
  // headless tool profile is undocumented surface the denial alone rests on.
  assert.match(s.hooks.PreToolUse[0].matcher, /\bGlob\b/);
  assert.match(s.hooks.PreToolUse[0].matcher, /\bGrep\b/);
  // A LOCAL session is untouched by all of it — the matcher it gets names no
  // file tool cc added, so nothing here can leak into an ordinary session.
  const local = JSON.parse(buildSettingsJSON({ hookCallbackUrl: 'http://h' }));
  assert.doesNotMatch(local.hooks.PreToolUse[0].matcher, /\bRead\b/);
});

// PINS S3: a redirected session asks the CLI NOT to inject its dynamic git
// instructions. The CLI shells out to run that git itself — unmarked, and
// outside cc's remote-forwarded Bash tool — and the union's project tier has no
// host side by design, so an unmarked caller there gets the remote's copy or
// -ENOENT, never a usable working tree. Guidance derived from that is worse
// than none. Measured against 2.1.250, whose own logic is
// `settings.includeGitInstructions ?? true`.
//
// Chosen over the CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS env var deliberately:
// that var's test is `e !== undefined ? !e : …`, so "0" disables while an EMPTY
// STRING re-enables — a footgun the moment anything sets it to a computed value.
test('a redirected session suppresses the CLI dynamic git instructions', () => {
  const s = JSON.parse(buildSettingsJSON({ hookCallbackUrl: 'http://h', redirect: true }));
  assert.equal(s.includeGitInstructions, false);
});

// PINS: a local session is unchanged — its cwd IS the repo, so the CLI's
// guidance is correct there and suppressing it would be a regression.
test('a local session keeps the CLI git instructions', () => {
  const s = JSON.parse(buildSettingsJSON({ hookCallbackUrl: 'http://h' }));
  assert.equal(s.includeGitInstructions, undefined);
});

// PINS: the rewrite reaches the CLI. Without `updatedInput` on the response the
// worker's own command runs — locally, in the session root — which is the one
// failure mode worse than refusing.
test('PreToolUse returns the redirector updatedInput alongside the allow', async () => {
  const { b } = broker({ redirect: {
    preToolUse: async () => ({ decision: 'allow', updatedInput: { command: 'node fwd' } }),
    postToolUse: async () => null,
  } });
  const res = fakeRes();
  b.handle(envelope(), res);
  await settled(res);
  assert.equal(res.body.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(res.body.hookSpecificOutput.updatedInput, { command: 'node fwd' });
});

// PINS: a redirector refusal is a DENY carrying its reason, in every mode. It
// is cc's own refusal about the boundary, not a question for the user, so it
// never becomes a permission card.
test('a redirector deny is answered as a deny, with no card', async () => {
  const { b, events } = broker({ mode: 'ask', redirect: {
    preToolUse: async () => ({ decision: 'deny', reason: 'outside the session root' }),
    postToolUse: async () => null,
  } });
  const res = fakeRes();
  b.handle(envelope({ tool_name: 'Write' }), res);
  await settled(res);
  assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.body.hookSpecificOutput.permissionDecisionReason, /outside the session root/);
  assert.equal(events.length, 0);
});

// PINS THE R7 FIX: the ask card shows the ORIGINAL command, and the allow that
// follows the user's click still carries the rewrite. Under redirection every
// Bash call is byte-identical to the permission layer, so the card is the only
// place the actual command can still be seen.
test('the ask card carries the pre-rewrite input, and the allow still rewrites', async () => {
  const { b, events } = broker({ mode: 'ask', redirect: {
    preToolUse: async () => ({ decision: 'allow', updatedInput: { command: "node fwd -- 'npm test'" } }),
    postToolUse: async () => null,
  } });
  const res = fakeRes();
  b.handle(envelope(), res);
  await new Promise(r => setTimeout(r, 5));

  const card = events.find(e => e.kind === 'permission_request');
  assert.deepEqual(card.toolInput, { command: 'npm test' }, 'the card shows what the worker asked for');

  assert.equal(b.resolve('tu1', true), true);
  await settled(res);
  assert.equal(res.body.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(res.body.hookSpecificOutput.updatedInput, { command: "node fwd -- 'npm test'" });
});

// A14 — PINS: `Read` IS HOOKED AND STILL NOT GATED, in ask mode. DELIBERATELY
// INVERTED FROM S1, whose "no exemption" assertion was correct only while Read
// was unhooked: S2 hooks it to refuse an unserved path (criterion 11), and
// without the exemption every read on a remote project becomes a permission
// card — a regression against a local session, where reads are deliberately not
// gated (src/settings.ts → ASK_GATED_TOOL_MATCHER).
//
// THE EXEMPTION IS SCOPED AND NARROW, and both halves are asserted here, so
// restoring it as a hole rather than as a list fails: a WRITE on the same
// redirected session still gates, and the exemption's list is `Read` alone.
test('a redirected Read is not gated in ask mode, while a Write still is', async () => {
  const mk = () => broker({ mode: 'ask', redirect: {
    preToolUse: async () => ({ decision: 'allow' }),
    postToolUse: async () => null,
  } });

  const read = mk();
  const readRes = fakeRes();
  read.b.handle(envelope({ tool_name: 'Read', tool_input: { file_path: '/x' } }), readRes);
  await settled(readRes);
  assert.equal(readRes.body.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(read.events, [], 'a read raised a permission card');

  // THE CONTROL, and without it the assertion above passes for a broker that
  // stopped gating altogether.
  const write = mk();
  const writeRes = fakeRes();
  write.b.handle(envelope({ tool_name: 'Write', tool_input: { file_path: '/x' } }), writeRes);
  for (let i = 0; i < 200 && write.events.length === 0; i++) await new Promise(r => setTimeout(r, 1));
  assert.equal(write.events.length, 1, 'a write was allowed without asking');
  assert.equal(writeRes.headersSent, false, 'the write was answered without a decision');
});

// PINS the other half of the scope: a LOCAL session's Read gates exactly as it
// did, because the exemption keys on `redirected`. Without this a broker that
// exempted Read unconditionally would pass the test above.
test('a local session in ask mode still gates a Read', async () => {
  const { b, events } = broker({ mode: 'ask' });
  const res = fakeRes();
  b.handle(envelope({ tool_name: 'Read', tool_input: { file_path: '/x' } }), res);
  for (let i = 0; i < 200 && events.length === 0; i++) await new Promise(r => setTimeout(r, 1));
  assert.equal(events.length, 1, 'the call was allowed without asking');
  assert.equal(res.headersSent, false, 'the response was sent without a decision');
});

// PINS: PostToolUse answers with the note as `additionalContext` — the only
// channel there is. A tool result can be annotated, never replaced.
test('PostToolUse answers with additionalContext, and omits it when there is none', async () => {
  const { b } = broker({ redirect: {
    preToolUse: async () => ({ decision: 'allow' }),
    postToolUse: async (name) => (name === 'Edit' ? 'Saved to /app/x on prod-box.' : null),
  } });
  const hit = fakeRes();
  b.handle({ hook_event_name: 'PostToolUse', tool_use_id: 't2', tool_name: 'Edit', tool_input: {}, tool_response: {} }, hit);
  await settled(hit);
  assert.equal(hit.body.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(hit.body.hookSpecificOutput.additionalContext, 'Saved to /app/x on prod-box.');

  const quiet = fakeRes();
  b.handle({ hook_event_name: 'PostToolUse', tool_use_id: 't3', tool_name: 'Bash', tool_input: {}, tool_response: {} }, quiet);
  await settled(quiet);
  assert.equal(quiet.body.hookSpecificOutput, undefined);
});

// PINS: a redirector that throws DENIES. Allowing the tool would run the
// worker's own command on the orchestrator's machine, in the session root —
// strictly worse than refusing, and invisible.
test('a redirector failure denies rather than falling through to allow', async () => {
  const { b } = broker({ redirect: {
    preToolUse: async () => { throw new Error('provider is gone'); },
    postToolUse: async () => null,
  } });
  const res = fakeRes();
  b.handle(envelope(), res);
  await settled(res);
  assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.body.hookSpecificOutput.permissionDecisionReason, /provider is gone/);
});

// PINS: with no redirector the broker behaves exactly as before — a local
// project's session must not change because this code exists.
test('with no redirector the broker is unchanged', async () => {
  const { b, events } = broker();
  const res = fakeRes();
  b.handle(envelope(), res);
  await settled(res);
  assert.equal(res.body.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(res.body.hookSpecificOutput.updatedInput, undefined);
  assert.equal(events.length, 0);
});


// PINS: a LOCAL session's ask gate is not narrowed by tool name. The exemption
// is scoped to redirection, so with no redirect attached the tool's name does
// not decide the outcome: neither `Read` (exempt only under redirect) nor a
// name in no matcher at all is auto-allowed on that ground.
test('a local ask-mode gate is not narrowed by tool name', async () => {
  for (const toolName of ['Read', 'FutureTool']) {
    const { b, events } = broker({ mode: 'ask' });
    const res = fakeRes();
    b.handle(envelope({ tool_name: toolName, tool_input: { file_path: '/x' } }), res);
    await new Promise(r => setTimeout(r, 5));

    assert.equal(res.headersSent, false, `${toolName} held open behind the card`);
    const card = events.find(e => e.kind === 'permission_request');
    assert.ok(card, `${toolName} raises a card on a local ask-mode session`);
    assert.equal(card.toolName, toolName);

    assert.equal(b.resolve('tu1', false), true);
    await settled(res);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  }
});

// PINS: the redirect exemption is a fixed list, not the complement of a gated
// set. A tool that is hooked under redirect but named in no list GATES — so
// widening the redirect matcher later cannot open a new auto-allow with nobody
// deciding it (card 2026-0339).
test('a redirected ask-mode session gates a tool that is in no list', async () => {
  const { b, events } = broker({ mode: 'ask', redirect: {
    preToolUse: async () => ({ decision: 'allow' }),
    postToolUse: async () => null,
  } });
  const res = fakeRes();
  b.handle(envelope({ tool_name: 'FutureTool', tool_input: {} }), res);
  await new Promise(r => setTimeout(r, 5));

  assert.equal(res.headersSent, false, 'held open behind the card');
  const card = events.find(e => e.kind === 'permission_request');
  assert.ok(card, 'an unlisted tool raises a card even under redirect');
  assert.equal(card.toolName, 'FutureTool');

  assert.equal(b.resolve('tu1', false), true);
  await settled(res);
  assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
});
