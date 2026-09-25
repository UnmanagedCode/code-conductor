// The hook plumbing redirection needs: what the injected settings ask the CLI
// for, and what the broker answers.
//
// Two things here are load-bearing beyond allow/deny on PreToolUse. The broker
// also carries `updatedInput` (the Bash rewrite) and answers PostToolUse with
// `additionalContext` (the write-back note).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookBroker } from '../src/hookBroker.ts';
import { buildSettingsJSON } from '../src/settings.ts';
import { FILE_TOOLS, SessionRedirect } from '../src/systems/toolRedirect.ts';
import { InstanceManager } from '../src/instances.ts';
import { redirectTierOptions } from './tierFixture.mjs';

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

function broker({ redirect = null } = {}) {
  const b = new HookBroker({ getRedirect: () => redirect });
  return { b };
}

const envelope = (over = {}) => ({
  hook_event_name: 'PreToolUse', tool_use_id: 'tu1', tool_name: 'Bash',
  tool_input: { command: 'npm test' }, ...over,
});

// PINS: without redirection the injected settings are what they were — no
// PostToolUse hook, no permissions block, Read unhooked. Every local project in
// the install runs through this function, so a change here that leaked to them
// would start prompting on reads.
test('a non-redirected session gets the settings it always got', () => {
  const s = JSON.parse(buildSettingsJSON({ hookCallbackUrl: 'http://h' }));
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Edit|Write|NotebookEdit|Bash');
  assert.equal(s.hooks.PostToolUse, undefined);
  assert.equal(s.permissions, undefined);
});

// PINS: a redirected session HOOKS Read, still registers PostToolUse (no
// consumer today; a write-back needs the seam), and REMOVES Glob and Grep,
// because a marked CLI's Grep spawns an unmarked `rg` that would search the
// wrong side and return silently wrong results.
//
// READ IS HOOKED TO REFUSE, NOT TO PULL (criterion 11): the union puts a served
// path's bytes there, so no PreToolUse pull is needed — but a Read aimed at a
// path the union does not serve to this session has to meet cc's refusal rather
// than an -ENOENT the model reads as "the file is absent".
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

// PINS: a redirected session asks the CLI NOT to inject its dynamic git
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

// PINS THE PORTLESS COUPLING, and it exists because a round-2 review reversed a
// claim of mine that was FALSE.
//
// THE CLAIM THAT WAS WRONG: that a redirected session with no `serverPort`
// degrades loudly, because `hookCallbackUrl` and `bashForwardUrl` share the
// `if (!this.serverPort) return null` guard, so `forwarderUrl` would be `''`
// and every forwarded command would fail visibly. They share a GUARD, not a
// FAILURE. With no `hookCallbackUrl`, `buildSettingsJSON` registers NO
// PreToolUse hook at all — so nothing ever consults the redirect, `Bash` is
// never rewritten, `forwarderUrl` is never read, and the worker's raw command
// runs LOCALLY with no refusal and no diagnostic. Silent execution against the
// wrong machine: exactly the failure class src/systems/toolRedirect.ts's
// invariant exists to prevent.
//
// UNREACHABLE IN PRODUCTION TODAY, by ordering: every create path is either
// served by the listening server or, for the one that is not
// (`restoreFromResumeManifest`), explicitly sequenced after `setServerPort`
// (server.ts, with a comment stating the dependency). A comment states intent;
// this states the coupling the intent rests on.
//
// SO WHAT IS PINNED IS THE BICONDITIONAL, not either guard: no hook URL ⟺ no
// forwarder URL ⟺ no registered PreToolUse hook. THE MUTATION THIS MUST DIE
// UNDER: giving `bashForwardUrl` (or `hookCallbackUrl`) a fallback while the
// other stays null — under it the two disagree, and a session could rewrite
// Bash with no hook to carry the rewrite, or register hooks pointing nowhere.
// Both are silent-local by another road.
test('with no server port, the hook URL and the forwarder URL degrade together', async () => {
  const im = new InstanceManager();               // never given a port
  const id = 'inst-portless';

  const coupled = () => {
    const hook = im.hookCallbackUrl(id);
    const fwd = im.bashForwardUrl(id);
    assert.equal(hook === null, fwd === null,
      `the two URLs disagree about the port: hook=${hook} forwarder=${fwd}`);
    return { hook, fwd };
  };

  // ── portless ──
  const off = coupled();
  assert.equal(off.hook, null);
  assert.equal(off.fwd, null);
  // …and the consequence: NO hook is registered, which is what makes the
  // redirect unreachable rather than merely broken.
  const sOff = JSON.parse(buildSettingsJSON({ hookCallbackUrl: off.hook ?? undefined, redirect: true }));
  assert.deepEqual(sOff.hooks.PreToolUse, [], 'a PreToolUse hook was registered with no callback URL');
  assert.equal(sOff.hooks.PostToolUse, undefined, 'a PostToolUse hook was registered with no callback URL');

  // The redirect's own rewrite is NOT self-disabling — it still produces a
  // `--url ''` argv — which is the evidence that the missing HOOK, and not a
  // failing forwarder, is the whole failure. Asserted so nobody re-derives my
  // wrong claim from the guard's existence.
  const redirect = new SessionRedirect({
    system: { execOneShot: async () => ({ code: 0, stdout: '', stderr: '' }) },
    systemId: 'prod-box', systemPath: '/srv/app',
    ...redirectTierOptions({ systemPath: '/srv/app' }),
    forwarderUrl: off.fwd ?? '',
    emit: () => {},
  });
  const d = await redirect.preToolUse('Bash', { command: 'echo hi' });
  assert.equal(d.decision, 'allow');
  assert.match(d.updatedInput.command, /--url ''/,
    'the rewrite silently stopped happening, which would hide the real failure');

  // ── THE CONTROL, and without it every assertion above passes for a manager
  // whose URL builders are simply broken. ──
  im.setServerPort(44279);
  const on = coupled();
  assert.notEqual(on.hook, null);
  assert.notEqual(on.fwd, null);
  const sOn = JSON.parse(buildSettingsJSON({ hookCallbackUrl: on.hook ?? undefined, redirect: true }));
  assert.equal(sOn.hooks.PreToolUse.length, 1, 'the port is set and still no hook is registered');
  assert.match(sOn.hooks.PreToolUse[0].hooks[0].url, /hook-callback$/);
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

// PINS: a redirector refusal is a DENY carrying its reason — cc's own refusal
// about the boundary.
test('a redirector deny is answered as a deny', async () => {
  const { b } = broker({ redirect: {
    preToolUse: async () => ({ decision: 'deny', reason: 'outside the session root' }),
    postToolUse: async () => null,
  } });
  const res = fakeRes();
  b.handle(envelope({ tool_name: 'Write' }), res);
  await settled(res);
  assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.body.hookSpecificOutput.permissionDecisionReason, /outside the session root/);
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

// PINS: with no redirector the broker allows the call as-is — a local
// session's tools run unrewritten.
test('with no redirector the broker allows every PreToolUse', async () => {
  const { b } = broker();
  const res = fakeRes();
  b.handle(envelope(), res);
  await settled(res);
  assert.equal(res.body.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(res.body.hookSpecificOutput.updatedInput, undefined);
});
