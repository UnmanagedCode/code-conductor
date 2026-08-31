// The local session root: what lands in one, and where its prefix rule draws
// the boundary.
//
// A session root is the Claude CLI's cwd for a worker on a remote project. It
// is NOT a mirror of the tree — it holds exactly the config surface the CLI
// reads implicitly and can never be hooked (§3.2's allow-list), pulled one way
// from the system. Everything else the worker touches arrives through a hooked
// tool.
//
// The fixture keeps the two sides distinguishable: the system's tree carries
// ONLY-ON-SYSTEM.txt, so a composer that accidentally read cc's own disk would
// produce a root that fails these assertions rather than one that happens to
// look right.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import {
  SESSION_ROOT_FILE_CAP_BYTES,
  SessionPathMap,
  composeSessionRoot,
  sessionRootPath,
  sessionRootsDir,
} from '../src/systems/sessionRoot.ts';

let home, remote;
beforeEach(async () => {
  ({ home } = await freshProjectsRoot());
  remote = await bindRemoteSystem();
});
afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

// A project tree ON THE SYSTEM, with the whole allow-list populated plus a
// generous amount of content that must NOT be pulled.
async function seedTree(root) {
  const w = async (rel, body) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  };
  await w('CLAUDE.md', '@CONVENTIONS.md\nproject notes\n');
  await w('CONVENTIONS.md', '<!-- cc:conventions -->\nrules\n');
  await w('.claude/settings.json', '{"a":1}');
  await w('.claude/settings.local.json', '{"b":2}');
  await w('.claude/skills/deploy/SKILL.md', 'deploy skill');
  await w('.claude/commands/ship.md', 'ship command');
  await w('.claude/agents/reviewer.md', 'reviewer agent');
  // NOT in the allow-list — the tree itself, and a .claude entry outside it.
  await w('ONLY-ON-SYSTEM.txt', 'system side');
  await w('src/index.js', 'console.log(1)\n');
  await w('.claude/history.jsonl', '{"nope":true}');
  return root;
}

async function compose({ worktree = null, systemPath } = {}) {
  return composeSessionRoot({
    system: await systemById(remote.id, null, 'test'),
    systemId: remote.id,
    systemPath: systemPath ?? remote.root,
    project: 'app',
    worktree,
  });
}

const listTree = async (dir) => {
  const out = [];
  const walk = async (rel) => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r); else out.push(r);
    }
  };
  await walk('');
  return out.sort();
};

// PINS: the composed root holds exactly §3.2's allow-list — no tree content, no
// unlisted `.claude` entry — so nothing outside the config surface is mirrored.
test('composing a session root pulls exactly the allow-list', async () => {
  await seedTree(remote.root);
  const { root, skipped } = await compose();

  assert.deepEqual(skipped, []);
  assert.deepEqual(await listTree(root), [
    '.claude/agents/reviewer.md',
    '.claude/commands/ship.md',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/skills/deploy/SKILL.md',
    'CLAUDE.md',
    'CONVENTIONS.md',
  ]);
  assert.equal(await fs.readFile(path.join(root, '.claude/skills/deploy/SKILL.md'), 'utf8'), 'deploy skill');
  assert.equal(await fs.readFile(path.join(root, 'CONVENTIONS.md'), 'utf8'), '<!-- cc:conventions -->\nrules\n');
});

// PINS: the session root's CLAUDE.md carries the @CONVENTIONS.md import even
// when the system's copy has none — the import is what delivers the conventions
// into the prompt, and nothing on the system is required to have arranged it.
test('a system CLAUDE.md with no import gets one prepended locally, keeping every byte', async () => {
  await seedTree(remote.root);
  await fs.writeFile(path.join(remote.root, 'CLAUDE.md'), 'user content\nmore\n');
  const { root } = await compose();
  assert.equal(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8'), '@CONVENTIONS.md\nuser content\nmore\n');
  // And the SYSTEM's copy is untouched — the pull is one way.
  assert.equal(await fs.readFile(path.join(remote.root, 'CLAUDE.md'), 'utf8'), 'user content\nmore\n');
});

// PINS: one level of `@`-import named in CLAUDE.md is pulled, so a project that
// splits its instructions across files still delivers them.
test('one level of @-import named in CLAUDE.md is pulled', async () => {
  await seedTree(remote.root);
  await fs.writeFile(path.join(remote.root, 'CLAUDE.md'), '@CONVENTIONS.md\n@docs/STYLE.md\n');
  await fs.mkdir(path.join(remote.root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(remote.root, 'docs/STYLE.md'), 'two spaces\n');
  await fs.writeFile(path.join(remote.root, 'docs/DEEP.md'), 'never pulled\n');

  const { root } = await compose();
  assert.equal(await fs.readFile(path.join(root, 'docs/STYLE.md'), 'utf8'), 'two spaces\n');
  await assert.rejects(fs.readFile(path.join(root, 'docs/DEEP.md')));
});

// PINS: an oversized allow-list entry is SKIPPED and named, never truncated and
// never fatal — a huge committed skill must not stop a session from starting.
test('an entry over the per-file cap is skipped and named, and the spawn still composes', async () => {
  await seedTree(remote.root);
  const big = path.join(remote.root, '.claude/skills/deploy/BIG.md');
  await fs.writeFile(big, 'x'.repeat(SESSION_ROOT_FILE_CAP_BYTES + 1));
  const { root, skipped } = await compose();

  assert.deepEqual(skipped.map(s => s.path), ['.claude/skills/deploy/BIG.md']);
  assert.match(skipped[0].reason, /cap/);
  // The rest of the allow-list still landed.
  assert.equal(await fs.readFile(path.join(root, '.claude/skills/deploy/SKILL.md'), 'utf8'), 'deploy skill');
  await assert.rejects(fs.readFile(path.join(root, '.claude/skills/deploy/BIG.md')));
});

// PINS: an entry deleted on the system disappears from the root on the next
// compose. A stale local copy is a boundary leak — Read would answer from a
// file Bash says does not exist.
test('re-composing drops an allow-list entry that has gone from the system', async () => {
  await seedTree(remote.root);
  const { root } = await compose();
  assert.ok(await fs.readFile(path.join(root, '.claude/commands/ship.md'), 'utf8'));

  await fs.rm(path.join(remote.root, '.claude/commands/ship.md'));
  await compose();
  await assert.rejects(fs.readFile(path.join(root, '.claude/commands/ship.md')));
});

// PINS: the root is keyed per (system, project, worktree), so two systems each
// hosting a project at the same path cannot collide on one local directory.
test('session roots are keyed per system, project and worktree', async () => {
  const a = sessionRootPath('prod-box', 'app', null);
  const b = sessionRootPath('other-box', 'app', null);
  const c = sessionRootPath('prod-box', 'app', 'feature');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith(sessionRootsDir('prod-box') + path.sep));
  assert.ok(c.startsWith(sessionRootsDir('prod-box') + path.sep));
});

// PINS: THE PREFIX RULE. A path under the session root maps to the system; a
// path anywhere else — an attachment under the store, `~/.claude`, `/tmp` — does
// not. Mapping one of those would send a local read to the wrong machine.
test('the prefix rule maps only what lies under the session root', async () => {
  const map = new SessionPathMap('/store/systems/box/sessions/app', '/srv/app');

  assert.equal(map.toSystem('/store/systems/box/sessions/app/src/index.js'), '/srv/app/src/index.js');
  assert.equal(map.toSystem('/store/systems/box/sessions/app'), '/srv/app');
  assert.equal(map.toLocal('/srv/app/src/index.js'), '/store/systems/box/sessions/app/src/index.js');

  // Outside, including the prefix-SHARING sibling that a string startsWith
  // would wrongly claim.
  assert.equal(map.toSystem('/store/systems/box/sessions/app-backup/x'), null);
  assert.equal(map.toSystem('/store/projects/app/attachments/note.txt'), null);
  assert.equal(map.toSystem('/home/u/.claude/plans/p.md'), null);
  assert.equal(map.toSystem('/tmp/scratch.txt'), null);
  assert.equal(map.toLocal('/srv/app-backup/x'), null);
  assert.equal(map.toLocal('/etc/passwd'), null);
});

// PINS: the composer refuses a relative session-root path rather than composing
// one against wherever cc happens to be running.
test('composing refuses a relative systemPath', async () => {
  await assert.rejects(() => compose({ systemPath: 'relative/app' }), /absolute/);
});

// ── The target the root was pulled FROM ──────────────────────────────
//
// The path template does not change when one system serves many targets: it
// keys on the project name, which is globally unique, so there is no collision
// to fix. What there IS to fix is INVALIDATION — a root pulled from one target
// and then re-used for another is silent, and it is the worst shape available.
// The worker reads `CLAUDE.md`, `CONVENTIONS.md` and the sparse content cache
// from the OLD target, edits them, and the write-back pushes the result to the
// NEW one, clobbering it with bytes from a different machine. Both sides stay
// internally consistent and the model has no way to see it.

// Two targets over one sandbox, so the SAME tree is reachable from both: the
// question here is whether the root is invalidated on a target change, and a
// tree only one of them could read would answer that by accident.
async function twoTargets() {
  const sandbox = await fs.realpath(await mkdtemp('cc-sr-'));
  const rec = await bindRemoteSystem({
    id: 'boxes', flags: ['--remote', `a=${sandbox}`, '--remote', `b=${sandbox}`],
  });
  await seedTree(sandbox);
  return { sandbox, id: rec.id };
}

const composeOn = async (id, remoteId, systemPath) => composeSessionRoot({
  system: await systemById(id, remoteId, 'test'),
  systemId: id,
  systemPath,
  project: 'app',
  worktree: null,
});

const manifestOf = async (id) => JSON.parse(
  await fs.readFile(`${sessionRootPath(id, 'app', null)}.manifest.json`, 'utf8'),
);

// PINS: the manifest records WHICH TARGET the root was pulled from.
test('the session-root manifest records the target it was pulled from', async () => {
  const { sandbox, id } = await twoTargets();
  await composeOn(id, 'a', sandbox);
  assert.equal((await manifestOf(id)).remoteId, 'a');
});

// PINS: re-composing against the SAME target keeps the root — including the
// sparse content cache a hooked Read populated, which is the whole reason the
// root is worth keeping.
test('re-composing on the same target keeps the root and its cached content', async () => {
  const { sandbox, id } = await twoTargets();
  const { root } = await composeOn(id, 'a', sandbox);
  const cached = path.join(root, 'src/index.js');
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, 'cached from a\n');

  await composeOn(id, 'a', sandbox);
  assert.equal(await fs.readFile(cached, 'utf8'), 'cached from a\n');
});

// PINS: re-composing against a DIFFERENT target removes the whole root and
// re-pulls. Diffing against a manifest that describes another machine is what
// leaves the old target's bytes under the new target's paths.
test('re-composing on a different target wipes the root and re-pulls', async () => {
  const { sandbox, id } = await twoTargets();
  const { root } = await composeOn(id, 'a', sandbox);
  const cached = path.join(root, 'src/index.js');
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, 'cached from a\n');

  await composeOn(id, 'b', sandbox);
  await assert.rejects(fs.readFile(cached), "the old target's cached content is gone");
  assert.equal((await manifestOf(id)).remoteId, 'b');
  // And the config surface really was pulled again, not merely left behind.
  assert.equal(await fs.readFile(path.join(root, 'CONVENTIONS.md'), 'utf8'), '<!-- cc:conventions -->\nrules\n');
});

// PINS: a manifest written before the field existed, against a handle bound to
// no target, is a MATCH — both normalise to null. Reading absence as a mismatch
// would wipe and re-pull every existing session root once.
test('a manifest with no remoteId matches an unbound handle', async () => {
  await seedTree(remote.root);
  const { root } = await compose();
  const cached = path.join(root, 'src/index.js');
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, 'still here\n');
  // Exactly the shape a pre-remoteId manifest has.
  const mf = `${sessionRootPath(remote.id, 'app', null)}.manifest.json`;
  const { entries } = JSON.parse(await fs.readFile(mf, 'utf8'));
  await fs.writeFile(mf, JSON.stringify({ entries }));

  await compose();
  assert.equal(await fs.readFile(cached, 'utf8'), 'still here\n');
});
