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
import { findUnenforceableBashRules } from '../src/systems/bashRules.ts';

let dir;
beforeEach(async () => { dir = await mkdtemp('cc-bashrules-'); });
afterEach(async () => { await rmrf(dir); });

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

  const found = await findUnenforceableBashRules([a, b]);
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
  assert.deepEqual(await findUnenforceableBashRules([p]), []);
});

// PINS: a bare `Bash` deny — the whole tool, not a pattern — is NOT a
// discrimination rule and survives redirection intact, because the CLI removes
// the tool outright rather than matching a command against it.
test('a bare Bash deny is not affected and does not trigger the refusal', async () => {
  const p = await write('.claude/settings.json', { permissions: { deny: ['Bash'] } });
  assert.deepEqual(await findUnenforceableBashRules([p]), []);
});

// PINS: a missing or malformed settings file is not a refusal. Most installs
// have no project settings at all, and a file cc cannot parse is the CLI's
// business to complain about, not a reason to block a session.
test('absent and unparseable settings files are skipped', async () => {
  const bad = path.join(dir, 'broken.json');
  await fs.writeFile(bad, '{ not json');
  assert.deepEqual(await findUnenforceableBashRules([path.join(dir, 'nope.json'), bad]), []);
});

// PINS: the user-level file is one of the sources. A global rule is exactly the
// one most likely to exist and least likely to be noticed going quiet.
test('the user settings path is included in the default source list', async () => {
  const { bashRuleSources } = await import('../src/systems/bashRules.ts');
  const sources = bashRuleSources('/session/root');
  assert.ok(sources.includes(path.join(os.homedir(), '.claude', 'settings.json')));
  assert.ok(sources.includes(path.join('/session/root', '.claude', 'settings.json')));
  assert.ok(sources.includes(path.join('/session/root', '.claude', 'settings.local.json')));
});
