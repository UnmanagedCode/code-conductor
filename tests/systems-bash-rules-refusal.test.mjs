// The permission-rule collapse a redirected `Bash` causes, and the refusal that
// keeps it from being silent.
//
// MEASURED against claude 2.1.250: `permissions.deny: ["Bash(touch:*)"]` IS
// enforced under `--permission-mode bypassPermissions
// --allow-dangerously-skip-permissions`, which is how every cc worker launches
// — the probe's `touch probe.txt` never ran. And rules match the POST-hook
// input, so once cc rewrites every Bash call into one forwarder invocation,
// every command becomes byte-identical to the permission layer and no
// `Bash(...)` rule can discriminate between any two of them.
//
// That is a safety rule that stops applying with nothing said. cc does not
// reimplement the CLI's matcher — a subset matcher that under-denies would be
// false assurance, which is worse — so it REFUSES the spawn and names the rules
// and the file each came from.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rmrf } from './rmrf.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bashRuleSources, findDisabledHooks, findUnenforceableBashRules, hooksDisabledRefusal } from '../src/systems/bashRules.ts';

let dir;
beforeEach(async () => { dir = await mkdtemp('cc-bashrules-'); });
afterEach(async () => { await rmrf(dir); });

// The project pair are read THROUGH the project's System handle now — they live
// on the system, and there is no local copy of them to stat. This fake answers
// from the same temp tree the host-scope reads use, so a test can still write a
// file and see it scanned, and it RECORDS what was asked of it so the scope
// routing is observable rather than assumed.
function fakeSystem() {
  const asked = [];
  return {
    asked,
    async readFileBytes(p) { asked.push(p); return await fs.readFile(p); },
  };
}

const proj = (p) => ({ path: p, scope: 'project' });

const write = async (name, obj) => {
  const p = path.join(dir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj));
  return p;
};

// PINS: a `Bash(...)` rule under deny or ask is found, and reported against the
// file it came from — the operator has to know which file to edit.
test('a Bash rule in deny or ask is found and attributed to its file', async () => {
  const a = await write('.claude/settings.json', { permissions: { deny: ['Bash(rm:*)', 'Read(./secrets/**)'] } });
  const b = await write('user/settings.json', { permissions: { ask: ['Bash(git push:*)'] } });

  const found = await findUnenforceableBashRules([proj(a), proj(b)], fakeSystem());
  assert.deepEqual(found, [
    { rule: 'Bash(rm:*)', source: a },
    { rule: 'Bash(git push:*)', source: b },
  ]);
});

// PINS: the refusal is about Bash ALONE. Rules for every other tool keep
// working under redirection — those tools are not rewritten — so refusing on
// one would block sessions for no reason.
test('rules for other tools, and a bare Bash allow, do not trigger the refusal', async () => {
  const p = await write('.claude/settings.json', {
    permissions: { deny: ['Read(./secrets/**)', 'WebFetch'], allow: ['Bash(npm test:*)'] },
  });
  assert.deepEqual(await findUnenforceableBashRules([proj(p)], fakeSystem()), []);
});

// PINS: a bare `Bash` deny — the whole tool, not a pattern — is NOT a
// discrimination rule and survives redirection intact, because the CLI removes
// the tool outright rather than matching a command against it.
test('a bare Bash deny is not affected and does not trigger the refusal', async () => {
  const p = await write('.claude/settings.json', { permissions: { deny: ['Bash'] } });
  assert.deepEqual(await findUnenforceableBashRules([proj(p)], fakeSystem()), []);
});

// PINS: a missing or malformed settings file is not a refusal. Most installs
// have no project settings at all, and a file cc cannot parse is the CLI's
// business to complain about, not a reason to block a session.
test('absent and unparseable settings files are skipped', async () => {
  const bad = path.join(dir, 'broken.json');
  await fs.writeFile(bad, '{ not json');
  assert.deepEqual(await findUnenforceableBashRules([proj(path.join(dir, 'nope.json')), proj(bad)], fakeSystem()), []);
});

// PINS: the user-level file is one of the sources. A global rule is exactly the
// one most likely to exist and least likely to be noticed going quiet.
test('the user settings path is included in the default source list', async () => {
  const sources = bashRuleSources('/srv/app');
  const at = (p) => sources.find(s => s.path === p);
  assert.equal(at(path.join(os.homedir(), '.claude', 'settings.json'))?.scope, 'host');
  // THE PROJECT PAIR ARE ON THE SYSTEM. Scoped, not merely listed: a project
  // file marked `host` would be read off the orchestrator's disk at the
  // project's remote path — a path that does not exist here — and the scan
  // would go silently empty.
  assert.equal(at(path.join('/srv/app', '.claude', 'settings.json'))?.scope, 'project');
  assert.equal(at(path.join('/srv/app', '.claude', 'settings.local.json'))?.scope, 'project');
});

// PINS T1: the MANAGED-POLICY file is one of the sources. It is the CLI's most
// authoritative settings layer and the one that fails worst — a `Bash(touch:*)`
// deny there is enforced today and goes silently dead under redirection — and no
// test can write `/etc`, so the shape of the source list is the only place it
// can be held. Dropping it from `bashRuleSources` left the whole suite green.
test('the managed-policy file is one of the sources both scans read', () => {
  const sources = bashRuleSources('/srv/app');
  const managed = sources.find(s => s.path === '/etc/claude-code/managed-settings.json');
  assert.ok(managed, `the managed-policy layer is scanned (got ${JSON.stringify(sources)})`);
  assert.equal(managed.scope, 'host', 'the managed policy is the ORCHESTRATOR\'s, never the system\'s');
  // Last, matching the CLI's own precedence order — it is the layer that wins.
  assert.equal(sources.at(-1).path, '/etc/claude-code/managed-settings.json');
});

// PINS: a `project`-scoped source is read through the SYSTEM HANDLE and a
// `host`-scoped one is not. The whole point of the scope field: reading the
// project pair locally would stat a remote path on the orchestrator's disk and
// find nothing, so both scans would go quietly empty instead of refusing.
test('project sources are read through the system, host sources are not', async () => {
  const onSystem = await write('.claude/settings.json', { disableAllHooks: true });
  const onHost = await write('user/settings.json', { disableAllHooks: true });
  const sys = fakeSystem();
  const found = await findDisabledHooks(
    [{ path: onSystem, scope: 'project' }, { path: onHost, scope: 'host' }], sys);
  assert.deepEqual(found, [onSystem, onHost], 'both layers are still scanned');
  assert.deepEqual(sys.asked, [onSystem], 'the host layer went through the system handle');
});

// ── B4: the one key that turns the whole redirect off ────────────────
//
// MEASURED against 2.1.250 with cc's exact settings shape: baseline the hook
// fires once and the command is the rewritten one; with `disableAllHooks: true`
// present, the hook fires ZERO times and the WORKER'S OWN command runs — on the
// orchestrator's machine, in the session root — while every result tells it the
// command ran on the system. The PostToolUse write-back dies with it: no pulls,
// no pushes, no notes.
//
// It does NOT disable `permissions.*`, so the injected denies still fire and the
// session does not fail loudly anywhere. It silently diverges, which is the one
// outcome the redirect exists to prevent. And the file is PULLED OFF THE SYSTEM
// every spawn (§3.4), so its content is not cc's — a user who disabled hooks
// locally and committed the file is enough.
//
// The other suppression shapes were tested and do NOT work: `{"hooks":{}}`,
// `{"hooks":null}` and `{"hooks":{"PreToolUse":[]}}` all leave the injected
// hooks firing. This is the single live lever.

// PINS: `disableAllHooks: true` is found in any of the scanned files, and
// attributed to the one it came from — the operator has to know which to edit.
test('disableAllHooks is found and attributed to its file', async () => {
  const a = await write('.claude/settings.json', { disableAllHooks: true });
  const b = await write('user/settings.json', { permissions: { deny: [] } });
  assert.deepEqual(await findDisabledHooks([proj(a), proj(b)], fakeSystem()), [a]);
});

// PINS: only the value that actually disables hooks counts. Refusing on a
// `false` — or on the key merely being present — would block sessions whose
// settings say hooks are ON.
test('only a true disableAllHooks refuses', async () => {
  const off = await write('.claude/settings.json', { disableAllHooks: false });
  const absent = await write('user/settings.json', { permissions: {} });
  assert.deepEqual(await findDisabledHooks([proj(off), proj(absent)], fakeSystem()), []);
});

// PINS: the refusal names the file and says what would have happened. "cc
// refuses" without the consequence reads as a cc bug rather than as the
// protection it is.
test('the refusal names the file and what it would have cost', async () => {
  const msg = hooksDisabledRefusal('prod-box', ['/root/.claude/settings.json']);
  assert.match(msg, /REDIRECT_HOOKS_DISABLED/);
  assert.match(msg, /\/root\/\.claude\/settings\.json/);
  assert.match(msg, /prod-box/);
  // The consequence, in the words that matter: the command would run HERE.
  assert.match(msg, /orchestrator|this machine|locally/i);
});

// PINS C9: the refusal names WHICH LAYER the setting came from. "Remove the
// setting" is unactionable advice when the file is `/etc/claude-code/managed-
// settings.json` — that layer is admin-owned, and the operator reading the
// refusal may not be the person who can edit it.
test('the refusal names the settings layer, and says so for an admin-owned one', async () => {
  // `admin-owned` cannot come from any path, so this is about cc LABELLING the
  // layer rather than about the filename happening to contain a word.
  const managed = hooksDisabledRefusal('prod-box', ['/etc/claude-code/managed-settings.json']);
  assert.match(managed, /admin-owned/, 'the managed-policy layer is labelled admin-owned');

  // And an ordinary layer is not mislabelled as admin-owned. The path below
  // contains no layer word either, so the label has to come from cc.
  const project = hooksDisabledRefusal('prod-box', ['/store/sessions/app/.claude/settings.json']);
  assert.ok(!/admin-owned/.test(project), project);
  assert.match(project, /project settings/, 'the project layer is labelled too');

  // The user layer, likewise labelled rather than inferred from its path.
  const user = hooksDisabledRefusal('prod-box', [path.join(os.homedir(), '.claude', 'settings.json')]);
  assert.match(user, /user settings/);
  assert.ok(!/admin-owned/.test(user), user);
});

// PINS: the scan shares its sources with the Bash-rule scan. Both answer the
// same question at the same moment about the same two pulled files, so a source
// added for one must be read by the other.
test('both scans read the same files', async () => {
  const p = await write('.claude/settings.json', { disableAllHooks: true, permissions: { deny: ['Bash(rm:*)'] } });
  assert.deepEqual(await findDisabledHooks([proj(p)], fakeSystem()), [p]);
  assert.deepEqual((await findUnenforceableBashRules([proj(p)], fakeSystem())).map(f => f.source), [p]);
});
