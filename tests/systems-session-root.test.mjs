// The local session root: what lands in one, and where its prefix rule draws
// the boundary.
//
// A session root is the Claude CLI's cwd for a worker on a remote project. It
// is NOT a copy of the tree — what is pulled ahead of time is exactly the
// config surface the CLI reads implicitly and can never be hooked (§3.2's
// allow-list), one way from the system; everything else the worker touches
// arrives through a hooked tool and materialises in the root.
//
// The fixture keeps the two sides distinguishable: the system's tree carries
// ONLY-ON-SYSTEM.txt, so a composer that accidentally read cc's own disk would
// produce a root that fails these assertions rather than one that happens to
// look right.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  assertTreeUnchanged, bindRemoteSystem, flakyLaunch, snapshotTree,
} from './remoteSystem.mjs';
import { liveSystemProto } from './systemHandle.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import {
  SESSION_ROOT_FILE_CAP_BYTES,
  SessionPathMap,
  composeSessionRoot,
  composedRootWasDiscarded,
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

// ── The LISTING fence, which is not one of the caps above ────────────
//
// The two caps bound PULLED CONTENT and skip a NAMED entry. The fence bounds
// the `find` output the walk is read out of, and past it the compose REFUSES —
// a listing cut at an arbitrary byte cannot say which entries it did not see.

// The fence written out rather than imported: a test that reads the number out
// of the module under test asserts only that it equals itself.
const LISTING_FENCE = 8 * 1024 * 1024;

// A tree whose LISTING outruns `targetBytes`, sized by record bytes rather than
// by file count — `%s\t%T@\t%p\0` is 25 bytes plus the path (`%T@` is 21
// characters, `%s` is 1 for an empty file), so long paths bust the fence in
// ~14,600 files instead of ~96,000. Two 180-character directory components plus
// a 180-character name keep the longest path inside macOS's PATH_MAX of 1024
// and every component inside NAME_MAX of 255.
// The writes go out in batches rather than one at a time. The NAMES are a pure
// function of the running count, so the file set and the listing it produces are
// what the sequential form produced — only the wall clock moves, which matters
// because more than one test now stands this fixture up.
async function floodSkills(root, targetBytes) {
  const dir = path.join(root, '.claude/skills', 'a'.repeat(180), 'a'.repeat(180));
  await fs.mkdir(dir, { recursive: true });
  let bytes = 0;
  let files = 0;
  while (bytes < targetBytes * 1.05) {
    const batch = [];
    while (batch.length < 64 && bytes < targetBytes * 1.05) {
      const abs = path.join(dir, 'b'.repeat(172) + String(files).padStart(8, '0'));
      batch.push(abs);
      bytes += 25 + Buffer.byteLength(abs);
      files += 1;
    }
    await Promise.all(batch.map(abs => fs.writeFile(abs, '')));
  }
  return { files, bytes };
}

// PINS: the `findManifest` exec this fixture reaches — the allow-list targets
// pass — carries `maxBufferBytes` at 8 MiB, and a real tree whose listing
// crosses it makes the compose REFUSE with a 502 rather than compose a root
// from the prefix of a listing.
//
// NOT claiming that the `@`-imports pass is observed here: this fixture throws
// at the targets pass, so the second pass never runs. What makes the fence
// universal is structural rather than asserted — ONE exec site serves both
// passes, so "fenced on one pass but not the other" is not expressible.
//
// NOT claiming, either, that the project is too large to work on: Bash still
// reaches every file in the tree, though the file tools do not (an advertised
// exclude denies them, src/systems/toolRedirect.ts). Nothing here bears on the
// two content caps, which keep skipping and naming.
test('the config-surface listing is FENCED: a tree that outruns it refuses the compose', async () => {
  await seedTree(remote.root);
  await floodSkills(remote.root, LISTING_FENCE);

  // The LIVE handle's prototype (tests/systemHandle.mjs): under the provider
  // configuration the seam in use is ProviderSystem, and a spy on the wrong
  // class would report zero calls. This arm OBSERVES only — the exec passes
  // through unchanged, so what fires is the production constant.
  const sysProto = liveSystemProto(await systemById(remote.id, null, 'test'));
  const origExec = sysProto.exec;
  const limits = [];
  try {
    sysProto.exec = function (spec, opts) {
      if (spec.argv?.[0] === 'find') limits.push(opts.maxBufferBytes);
      return origExec.call(this, spec, opts);
    };
    await assert.rejects(() => compose(), (e) => {
      assert.equal(e.statusCode, 502);
      assert.match(e.message, /will not compose a session root from a partial listing/);
      assert.ok(e.message.includes(String(LISTING_FENCE)),
        `the refusal must name the fence; got: ${e.message}`);
      return true;
    });
  } finally { sysProto.exec = origExec; }

  assert.deepEqual([...new Set(limits)], [LISTING_FENCE],
    `every findManifest exec this compose reached must carry the fence; saw ${JSON.stringify(limits)}`);
});

// PINS: the overflow is READ BEFORE THE RECORDS ARE — an overflowed listing
// refuses as an overflow, never as the far side having sent a malformed record.
//
// NOT claiming: anything about the fence's VALUE (the ceiling is shrunk at the
// seam here, exactly as tests/worktrees.test.mjs shrinks runGit's), nor that the
// straddling record is always unparseable — at 8 MiB it usually parses, which is
// the whole reason the check cannot live after the loop.
test('an overflowed listing refuses as an overflow, not as a malformed record', async () => {
  await seedTree(remote.root);

  // 12 bytes is deterministic, not lucky: with all seven targets present `find`
  // writes nothing to stderr, and the collector's byte count is shared across
  // both streams, so the retained 12 bytes are the head of the first stdout
  // record. `%T@` is 21 characters, so 12 bytes cannot reach that record's
  // second tab and its tail can never parse.
  const sysProto = liveSystemProto(await systemById(remote.id, null, 'test'));
  const origExec = sysProto.exec;
  try {
    sysProto.exec = function (spec, opts) {
      return origExec.call(this, spec, spec.argv?.[0] === 'find' ? { ...opts, maxBufferBytes: 12 } : opts);
    };
    await assert.rejects(() => compose(), (e) => {
      assert.equal(e.statusCode, 502);
      assert.ok(!/unparseable find record/.test(e.message),
        `cc's own fence must not be reported as the far side's malformed output; got: ${e.message}`);
      assert.match(e.message, /will not compose a session root from a partial listing/);
      return true;
    });
  } finally { sysProto.exec = origExec; }
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

// ── THE MIRROR the root is the image OF (card 2026-0259) ─────────────
//
// After P7 the session root is the local image of the provider's advertised
// MIRROR ROOT, not of the project tree, and the CLI's cwd moves to the
// project's place inside it. What must NOT move is the allow-list walk: it
// stays anchored at the project over its seven fixed targets, because a walk
// re-anchored at a filesystem root was measured at 46 MB of `find` output and
// half a gigabyte of orchestrator heap — and pruning the pseudo-filesystems
// does not rescue it.

const RECORDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recordingProvider.mjs');

async function wire(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// Every `find` argv cc put on the wire during one composition.
const findArgvs = async (rec) => (await wire(rec))
  .filter(f => f.type === 'exec' && Array.isArray(f.argv) && f.argv[0] === 'find')
  .map(f => f.argv);

// A recording provider under its own system id, with whatever mirror flags.
async function recordingSystem(id, flags) {
  const rec = path.join(await mkdtemp('cc-wire-'), `${id}.jsonl`);
  await addSystem({ id, label: id, launch: ['node', RECORDER, '--record', rec, ...flags] });
  return { rec, sys: await systemById(id, null, 'test') };
}

// PINS THE MEASURED DECISION, DIFFERENTIALLY: widening the mirror to `/` does
// not change the manifest walk by one byte. Both argvs are produced in this
// same run and compared TO EACH OTHER — D-P7-10 form 1 — so no constant
// transcribed from the implementation could satisfy it.
//
// NOT CLAIMING: that the walk is cheap. The numbers behind the decision are
// evidence in the design, not an assertion here.
test('the find argv is identical whether the mirror is the project or the whole filesystem', async () => {
  await seedTree(remote.root);
  const narrow = await recordingSystem('narrow', []);
  const wide = await recordingSystem('wide', ['--mirror', '/']);

  await composeSessionRoot({
    system: narrow.sys, systemId: 'narrow', systemPath: remote.root, project: 'app',
  });
  const wideComposed = await composeSessionRoot({
    system: wide.sys, systemId: 'wide', systemPath: remote.root, project: 'app',
  });

  // The two configurations really are different, or the comparison is vacuous.
  assert.equal(wideComposed.mirror.mirrorRoot, '/');
  assert.notEqual(wideComposed.cwd, wideComposed.root);

  const a = await findArgvs(narrow.rec);
  const b = await findArgvs(wide.rec);
  assert.ok(a.length > 0, 'the narrow composition really walked');
  assert.deepEqual(b, a, 'the walk is invariant to mirror width');
});

// PINS: the pulled config surface lands under the CLI's cwd — the project's
// place inside the image — not at the image root, and the CLAUDE.md that
// carries the `@CONVENTIONS.md` import is the one at that cwd.
//
// NOT CLAIMING: anything about the empty ancestor directories above the cwd.
// An ancestor CLAUDE.md on the system is deliberately not pulled.
test('a wider mirror puts the pulled config under the cwd, not the image root', async () => {
  await seedTree(remote.root);
  const parent = path.dirname(remote.root);
  const { sys } = await recordingSystem('wider', ['--mirror', parent]);
  const composed = await composeSessionRoot({
    system: sys, systemId: 'wider', systemPath: remote.root, project: 'app',
  });

  assert.equal(composed.mirror.offset, path.basename(remote.root));
  assert.equal(composed.cwd, path.join(composed.root, path.basename(remote.root)));
  assert.equal(await fs.readFile(path.join(composed.cwd, 'CONVENTIONS.md'), 'utf8'),
    '<!-- cc:conventions -->\nrules\n');
  assert.match(await fs.readFile(path.join(composed.cwd, 'CLAUDE.md'), 'utf8'), /@CONVENTIONS\.md/);
  await assert.rejects(fs.readFile(path.join(composed.root, 'CONVENTIONS.md')),
    'and nothing was written at the image root');
});

// The paths `find` was pointed AT — the operands before the expression starts.
// Separated from the prune operands, which name the same kind of thing in a
// different role.
const findTargets = (argv) => {
  const end = argv.findIndex(a => a === '(' || a === '-type');
  return argv.slice(1, end === -1 ? argv.length : end);
};

// PINS CRITERION 7 at target granularity: an advertised exclude covering one of
// the seven walked targets drops it from what `find` is pointed at, and nothing
// under it is pulled.
//
// PINS, rather than disclaims, the within-a-walked-directory case: it is
// covered by its own test above ('an exclude beneath a walked target is neither
// enumerated nor pulled'), which this one is the coarse-grained half of.
//
// NOT CLAIMING: that the walk's targets are ever anything but the seven fixed
// allow-list entries. They are built from ALLOW_FILES/ALLOW_DIRS relative to
// the project, so `/proc` and `/dev` cannot become targets by widening a mirror
// root however wide it goes — asserted differentially two tests up.
test('an exclude covering an allow-list target drops it from the walk', async () => {
  await seedTree(remote.root);
  const skills = path.join(remote.root, '.claude/skills');
  const { rec, sys } = await recordingSystem('trimmed', [
    '--mirror', path.dirname(remote.root), '--exclude', skills,
  ]);
  const composed = await composeSessionRoot({
    system: sys, systemId: 'trimmed', systemPath: remote.root, project: 'app',
  });

  const [argv] = await findArgvs(rec);
  assert.ok(argv, 'a walk happened');
  const targets = findTargets(argv);
  assert.ok(!targets.includes(skills), `the excluded target is gone from ${JSON.stringify(targets)}`);
  assert.ok(targets.includes(path.join(remote.root, 'CLAUDE.md')), 'the rest are still there');
  await assert.rejects(fs.readFile(path.join(composed.cwd, '.claude/skills/deploy/SKILL.md')),
    'and nothing under it was pulled');
});

// PINS: the manifest records the MIRROR ROOT beside the target, and a mismatch
// resets the root for the same reason a target change does — the old layout
// describes a different address space, so `cwd` sits somewhere else inside it.
//
// NOT CLAIMING: that a session already running picks up the new geometry; the
// instance's cwd is fixed at create.
test('a mirrorRoot change in the manifest wipes the root; an unchanged one keeps it', async () => {
  await seedTree(remote.root);
  const parent = path.dirname(remote.root);
  await recordingSystem('shift', ['--mirror', parent]);

  const first = await composeSessionRoot({
    system: await systemById('shift', null, 'test'), systemId: 'shift', systemPath: remote.root, project: 'app',
  });
  const mf = `${sessionRootPath('shift', 'app', null)}.manifest.json`;
  assert.equal(JSON.parse(await fs.readFile(mf, 'utf8')).mirrorRoot, parent);

  const cached = path.join(first.cwd, 'src/index.js');
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, 'cached under the old geometry\n');

  // Same advertisement: kept.
  await composeSessionRoot({
    system: await systemById('shift', null, 'test'), systemId: 'shift', systemPath: remote.root, project: 'app',
  });
  assert.equal(await fs.readFile(cached, 'utf8'), 'cached under the old geometry\n');

  // A narrower advertisement: the whole root goes.
  await updateSystem('shift', { launch: ['node', RECORDER, '--record', path.join(await mkdtemp('cc-wire-'), 'b.jsonl')] });
  const after = await composeSessionRoot({
    system: await systemById('shift', null, 'test'), systemId: 'shift', systemPath: remote.root, project: 'app',
  });
  await assert.rejects(fs.readFile(cached), 'the old geometry\'s content is gone');
  assert.equal(after.cwd, after.root);
  assert.equal(await fs.readFile(path.join(after.root, 'CONVENTIONS.md'), 'utf8'),
    '<!-- cc:conventions -->\nrules\n');
});

// PINS: a manifest written before `mirrorRoot` existed, against a placement
// that advertises nothing, is a MATCH — not a wipe. Reading absence as a
// mismatch would cost every existing session root one pointless full re-pull.
//
// NOT CLAIMING: anything about a legacy manifest against an ADVERTISED mirror;
// that is a genuine mismatch and wipes, which the test above covers.
test('a manifest with no mirrorRoot matches an unadvertised placement', async () => {
  await seedTree(remote.root);
  const { root } = await compose();
  const cached = path.join(root, 'src/index.js');
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, 'still here\n');
  const mf = `${sessionRootPath(remote.id, 'app', null)}.manifest.json`;
  const { entries } = JSON.parse(await fs.readFile(mf, 'utf8'));
  await fs.writeFile(mf, JSON.stringify({ entries }));

  await compose();
  assert.equal(await fs.readFile(cached, 'utf8'), 'still here\n');
});

// PINS: an advertisement cc cannot use refuses the COMPOSITION by name, at
// spawn — not the project's resolution. Nothing else about the project is
// touched, because git, status, diff and every project_* tool run at the
// project path and never consult the mirror.
//
// NOT CLAIMING: which HTTP status a route surfaces, or that the project listing
// stays green — tests/systems-listing-degrade.test.mjs owns the listing.
test('a mirror root that does not contain the project refuses the composition', async () => {
  await seedTree(remote.root);
  const elsewhere = await fs.realpath(await mkdtemp('cc-elsewhere-'));
  await recordingSystem('wrongroot', ['--mirror', elsewhere]);
  await assert.rejects(
    async () => composeSessionRoot({
      system: await systemById('wrongroot', null, 'test'),
      systemId: 'wrongroot', systemPath: remote.root, project: 'app',
    }),
    (e) => e.code === 'MIRROR_ROOT_EXCLUDES_PROJECT' && e.statusCode === 501,
  );
});

// ── THE EXCLUDE BYPASS CLASS (card 2026-0259, review round 1) ────────
//
// Filtering the walk's TARGETS is not filtering the walk. Two ways past it were
// measured on a live provider, and they are the same defect at two granularities:
// an exclude that names something the seven fixed targets do not name is not a
// target, so it never met the target filter, and the pull loop that turns a
// record into bytes on disk had no gate of its own.
//
// Both halves are asserted for each: NOT ENUMERATED (absent from the manifest,
// which is the enumeration record and is written to disk beside the root) and
// NOT ON DISK. A fix that gated only the pull would still fail the first.

const readManifestJson = async (systemId, project) =>
  JSON.parse(await fs.readFile(`${sessionRootPath(systemId, project, null)}.manifest.json`, 'utf8'));

// PINS INSTANCE 2: an exclude covering a subpath BENEATH one of the seven
// walked targets withholds that subpath — it is absent from the manifest and
// absent from disk — while its siblings under the same target are still pulled.
// The excluded target's parent stays in the walk, so this cannot be satisfied
// by dropping the target.
//
// NOT CLAIMING: that the far side's `find` process physically declined to
// stat the file. The prune operands are asserted structurally below; what is
// measured here is that nothing about the excluded path survives into cc.
test('an exclude beneath a walked target is neither enumerated nor pulled', async () => {
  await seedTree(remote.root);
  const secret = path.join(remote.root, '.claude/skills/secret');
  await fs.mkdir(secret, { recursive: true });
  await fs.writeFile(path.join(secret, 'sk.md'), 'SECRET-SKILL-BYTES');

  const { sys } = await recordingSystem('deep', [
    '--mirror', path.dirname(remote.root), '--exclude', secret,
  ]);
  const composed = await composeSessionRoot({
    system: sys, systemId: 'deep', systemPath: remote.root, project: 'app',
  });

  const entries = Object.keys((await readManifestJson('deep', 'app')).entries);
  assert.ok(entries.includes('.claude/skills/deploy/SKILL.md'),
    `the sibling under the same walked target is still pulled: ${JSON.stringify(entries)}`);
  assert.ok(!entries.includes('.claude/skills/secret/sk.md'),
    `the excluded subpath was ENUMERATED into the manifest: ${JSON.stringify(entries)}`);
  await assert.rejects(fs.readFile(path.join(composed.cwd, '.claude/skills/secret/sk.md')),
    'and its bytes are not on disk');
});

// PINS INSTANCE 1: the second `find` pass, over the `@`-imports named by the
// pulled CLAUDE.md, is bound by the same exclude list as the first — an
// imported file under an exclude is neither enumerated nor pulled, while an
// imported file that is not excluded still is.
//
// NOT CLAIMING: anything about how imports are PARSED; the unexcluded import
// arriving is what shows the pass ran at all.
test('an exclude covering an @-imported file binds the second walk too', async () => {
  await seedTree(remote.root);
  await fs.mkdir(path.join(remote.root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(remote.root, 'docs/shared.md'), 'SECRET-IMPORT-BYTES');
  await fs.writeFile(path.join(remote.root, 'docs/open.md'), 'PUBLIC-IMPORT-BYTES');
  await fs.writeFile(path.join(remote.root, 'CLAUDE.md'),
    '@CONVENTIONS.md\n@docs/shared.md\n@docs/open.md\n');

  const { sys } = await recordingSystem('imports', [
    '--mirror', path.dirname(remote.root), '--exclude', path.join(remote.root, 'docs/shared.md'),
  ]);
  const composed = await composeSessionRoot({
    system: sys, systemId: 'imports', systemPath: remote.root, project: 'app',
  });

  const entries = Object.keys((await readManifestJson('imports', 'app')).entries);
  assert.ok(entries.includes('docs/open.md'),
    `the unexcluded import still arrives, so the second pass ran: ${JSON.stringify(entries)}`);
  assert.ok(!entries.includes('docs/shared.md'),
    `the excluded import was ENUMERATED into the manifest: ${JSON.stringify(entries)}`);
  await assert.rejects(fs.readFile(path.join(composed.cwd, 'docs/shared.md')),
    'and its bytes are not on disk');
});

// PINS: an exclude that could match something under a walked target is carried
// into the `find` itself as a prune operand, so the far side never descends
// into it — enumeration leaks names, sizes and mtimes even when the bytes are
// withheld. Both spellings are present: the entry itself and everything under
// it. Excludes that cannot intersect the project are NOT sent, so the argv
// stays bounded by the tree rather than by the advertisement's length.
//
// NOT CLAIMING: that `find` honours the operands — that is the far side's
// behaviour, and the per-record gate behind it is what makes cc's answer
// correct either way. The two tests above measure the outcome.
test('an exclude inside the project is pruned at the find; one outside it is not sent', async () => {
  await seedTree(remote.root);
  const secret = path.join(remote.root, '.claude/skills/secret');
  const { rec, sys } = await recordingSystem('pruned', [
    '--mirror', '/', '--exclude', secret, '--exclude', '/proc',
  ]);
  await composeSessionRoot({
    system: sys, systemId: 'pruned', systemPath: remote.root, project: 'app',
  });

  const [argv] = await findArgvs(rec);
  assert.ok(argv.includes('-prune'), `no prune in ${JSON.stringify(argv)}`);
  // The prune operands, read out of the expression rather than off the whole
  // argv — the excluded path also appears as a dropped TARGET in other shapes.
  const pruned = argv.slice(argv.indexOf('('), argv.indexOf('-prune'));
  assert.ok(pruned.includes(secret), `the entry itself is a prune operand: ${JSON.stringify(pruned)}`);
  assert.ok(pruned.includes(`${secret}/*`), 'and so is everything under it');
  assert.ok(!argv.includes('/proc') && !argv.includes('/proc/*'),
    `an exclude that cannot intersect the project is not sent: ${JSON.stringify(argv)}`);
  assert.ok(argv.includes(path.join(remote.root, '.claude/skills')),
    'the parent target stays in the walk, so this is not the target filter');
});

// ── GATE 3 ON ITS OWN: a far side that does not honour `-prune` ──────
//
// The three gates in findManifest are narrowest-first, and against a real
// `find` the outer two do all the visible work: prune stops the record on the
// far side, so the per-record gate never sees one and dropping it changes
// nothing observable. That makes the backstop's own behaviour untested — and it
// is the gate that closes the class, because it is the one point every listing
// flows through.
//
// The only way to exercise it is a far side that ignores the operands cc sent,
// which is exactly the case it was written for. `--ignore-prune` strips the
// clause out of the argv before running it.
const MIRROR_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mirrorFixtureProvider.mjs');

// PINS: when the far side enumerates an excluded path anyway, cc drops the
// record — it reaches neither the manifest nor the disk — and it is proven that
// the record REALLY ARRIVED, by decoding the `find` output cc received off the
// wire. Without that last part the test would pass just as well against a far
// side that quietly honoured prune after all.
//
// NOT CLAIMING: that any real `find` behaves this way, or that prune is
// unnecessary. Prune is what keeps names, sizes and mtimes off the wire in the
// first place; this pins what cc does when it did not work.
test('a find that ignores -prune still cannot get an excluded path into the root', async () => {
  await seedTree(remote.root);
  const w = async (rel, body) => {
    await fs.mkdir(path.dirname(path.join(remote.root, rel)), { recursive: true });
    await fs.writeFile(path.join(remote.root, rel), body);
  };
  await w('.claude/skills/secret/sk.md', 'SECRET-SKILL-BYTES');
  await w('.claude/skills/public/ok.md', 'PUBLIC-SKILL-BYTES');

  const excluded = path.posix.join(remote.root, '.claude', 'skills', 'secret');
  const frames = path.join(await mkdtemp('cc-noprune-'), 'frames.jsonl');
  await addSystem({
    id: 'noprune',
    label: 'noprune',
    launch: ['node', MIRROR_FIXTURE, '--advertise-mirror', remote.root,
      '--advertise-exclude', excluded, '--ignore-prune', '--frame-log', frames],
  });
  const { root } = await composeSessionRoot({
    system: await systemById('noprune', null, 'test'),
    systemId: 'noprune',
    systemPath: remote.root,
    project: 'p',
    worktree: null,
  });

  // THE RECORD REALLY ARRIVED. The walk's output comes back as `stdout` frames,
  // which the fixture logs after every mutation it makes — so this is the find
  // output cc RECEIVED, not what the fixture intended to send.
  const logged = (await fs.readFile(frames, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const findOutput = Buffer.concat(
    logged.filter(f => f.type === 'stdout' && typeof f.dataB64 === 'string')
      .map(f => Buffer.from(f.dataB64, 'base64')),
  ).toString('utf8');
  assert.ok(findOutput.includes('.claude/skills/secret/sk.md'),
    'the far side enumerated the excluded path — otherwise this test proves nothing');
  assert.ok(findOutput.includes('.claude/skills/public/ok.md'),
    'and the walk ran normally alongside it');

  // AND CC DROPPED IT. Both halves: never enumerated into cc's own record of
  // the root, and never written.
  const manifest = JSON.parse(await fs.readFile(`${root}.manifest.json`, 'utf8'));
  assert.equal(manifest.entries['.claude/skills/secret/sk.md'], undefined,
    'the excluded record is absent from the manifest');
  assert.ok(manifest.entries['.claude/skills/public/ok.md'], 'its unexcluded sibling is present');
  await assert.rejects(fs.readFile(path.join(root, '.claude/skills/secret/sk.md')),
    'and no bytes reached the session root');
  assert.equal(
    await fs.readFile(path.join(root, '.claude/skills/public/ok.md'), 'utf8'),
    'PUBLIC-SKILL-BYTES',
  );
  // Sharper than "not on disk": the bytes were never even FETCHED. Every
  // readFile payload that crossed back carries the sibling and none the secret,
  // so the drop happened before the pull rather than after it.
  const fetched = Buffer.concat(
    logged.filter(f => f.type === 'data' && typeof f.dataB64 === 'string')
      .map(f => Buffer.from(f.dataB64, 'base64')),
  ).toString('utf8');
  assert.ok(fetched.includes('PUBLIC-SKILL-BYTES'), 'the sibling was fetched');
  assert.ok(!fetched.includes('SECRET-SKILL-BYTES'), 'the excluded file was never fetched');
});

// ── A COMPOSE THAT FAILS AFTER THE TARGET CHECK DISCARDED THE ROOT ───
//
// The target check runs BEFORE the root exists, and a mismatch removes the root
// AND its manifest before the walk runs. So a failure past that point is not
// just "the compose refused": there is no last-good root behind it, which is
// the fact a caller that would otherwise warn and carry on has to know.
// `composedRootWasDiscarded` is how it is told.
//
// KEYED ON THE CHECK, NOT ON THE FAILURE. The three arms below are three
// different ways the walk can fail, and the control test pairs each with the
// same failure behind a check that HELD. What differs across that pair is the
// check alone, which is why the mark can be set where it is.
//
// THE MISMATCH ROUTE is a handle bound to remote `a` against a root whose
// manifest has been removed — `readManifest` documents the manifest as a cache
// whose loss costs a re-pull and nothing else, so its absence is a supported
// state rather than a broken fixture. It keeps every arm on ONE target, so the
// marked case and its control differ in nothing but the check.

// A system serving target `a` over its own seeded sandbox, composed once so the
// root and the manifest naming `a` — the last-good pair each arm starts from —
// really exist.
async function lastGoodRootOnA(id) {
  const sandbox = await fs.realpath(await mkdtemp('cc-sr-discard-'));
  await seedTree(sandbox);
  const flags = ['--remote', `a=${sandbox}`];
  await bindRemoteSystem({ id, flags });
  await composeOn(id, 'a', sandbox);
  return { sandbox, flags };
}

// What makes the NEXT compose's target check not hold: an absent manifest reads
// as `remoteId: null`, which no longer agrees with a handle bound to `a`.
const dropManifest = (id) => fs.rm(`${sessionRootPath(id, 'app', null)}.manifest.json`, { force: true });

// PINS: a walk that fails after the target check did not hold marks the error,
// and what it leaves behind is a root with no config surface in it and no
// manifest beside it. The failure is the REAL production fence firing on a real
// flooded tree, not an injected one.
//
// NOT CLAIMING anything about the fence's value or its message — card 2026-0267
// owns those, and this must stay green if that number ever moves.
test('a walk that fails after the target check did not hold marks the error and leaves no manifest', async () => {
  const id = 'discarded-fence';
  const { sandbox } = await lastGoodRootOnA(id);
  await floodSkills(sandbox, LISTING_FENCE);
  await dropManifest(id);

  await assert.rejects(() => composeOn(id, 'a', sandbox), (e) => {
    assert.equal(composedRootWasDiscarded(e), true, `the failure was not marked: ${e.message}`);
    return true;
  });

  // Derived from the store path, not from anything the compose handed back:
  // the compose threw, so it handed back nothing to read a path out of.
  const root = sessionRootPath(id, 'app', null);
  assert.deepEqual(await listTree(root), [], 'no config surface is left at the root');
  await assert.rejects(fs.readFile(`${root}.manifest.json`), 'and no manifest beside it');
});

// PINS: the mark is set by the target check, so it does not depend on HOW the
// walk failed — a command the far side refuses to start and a transport that
// dies after really forwarding it are both marked.
//
// NOT CLAIMING that these are the only ways to fail. A `readFile` failure
// during the pull, after the reset, reaches the same state and throws a raw
// `Error` with no `statusCode`; it is not pinned here precisely because the
// mark cannot tell these apart.
test('the mark does not depend on how the walk failed', async () => {
  for (const [id, cfg] of [
    ['discarded-refused', { errorFrame: 'find' }],
    ['discarded-death', { dieOn: 'find' }],
  ]) {
    const { sandbox, flags } = await lastGoodRootOnA(id);
    // updateSystem disposes the live handle, so the system really was up for
    // the compose above and really is failing from here on.
    await updateSystem(id, { launch: flakyLaunch({ ...cfg, flags }) });
    await dropManifest(id);

    await assert.rejects(() => composeOn(id, 'a', sandbox), (e) => {
      assert.equal(composedRootWasDiscarded(e), true,
        `${JSON.stringify(cfg)} left the failure unmarked: ${e.message}`);
      return true;
    });
  }
});

// CONTROL. PINS: the same three failures behind a target check that HELD are
// NOT marked, and the prior root and its manifest survive each of them
// byte-identical. This is what stops the fix becoming "refuse on every compose
// failure" — a system that is briefly unreachable must keep resuming on its
// last good root, which is card 2026-0267's deliberate warn-and-continue.
//
// NOT CLAIMING that the compose succeeds: all three still throw. The claim is
// about what is left behind and how it is marked, not about whether it refused.
test('the same failures with the target check HOLDING are not marked, and the prior root survives', async () => {
  for (const [id, cfg] of [
    ['held-fence', null],
    ['held-refused', { errorFrame: 'find' }],
    ['held-death', { dieOn: 'find' }],
  ]) {
    const { sandbox, flags } = await lastGoodRootOnA(id);
    if (cfg) await updateSystem(id, { launch: flakyLaunch({ ...cfg, flags }) });
    else await floodSkills(sandbox, LISTING_FENCE);

    const root = sessionRootPath(id, 'app', null);
    const before = await snapshotTree(root);
    assert.ok(before.has('CLAUDE.md'), `${id}: there is a last-good root to survive`);

    // No dropManifest: the manifest the compose above wrote still names `a`.
    await assert.rejects(() => composeOn(id, 'a', sandbox), (e) => {
      assert.equal(composedRootWasDiscarded(e), false,
        `${id}: a failure behind a holding check was marked: ${e.message}`);
      return true;
    });

    assertTreeUnchanged(assert, before, await snapshotTree(root), `${id}: the prior root`);
    assert.equal(JSON.parse(await fs.readFile(`${root}.manifest.json`, 'utf8')).remoteId, 'a',
      `${id}: and its manifest still names the target it was pulled from`);
  }
});
