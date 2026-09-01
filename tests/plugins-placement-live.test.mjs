// A PLUGIN'S FRAGMENT BODIES FOLLOW ITS PROJECT, AND STOP WHEN THE PROJECT IS
// UNREGISTERED — card 2026-0263.
//
// The plugin catalog used to CAPTURE a contributing project's placement (its
// System, target and dir) at the last rescan, and read fragment bodies through
// that copy. Nothing outside the plugin host tells it a project moved, so after
// a placement mutation the host kept composing the OLD tree's bytes into every
// referencing project's `CONVENTIONS.md` — and into the conductor's own role
// prompt for a `scope:"conductor"` fragment — while reporting the catalog
// healthy. Reading a body is a question about a machine, so the placement has
// to be resolved LIVE, at the moment of the read.
//
// WHAT MAKES EACH CLAIM HERE HONEST, and why a content assertion alone is not
// enough: with a fencing provider and distinct roots one absolute path cannot
// exist on two targets, so the correct post-mutation answer is
// refused-and-skipped — which looks identical to "the host asked nobody at all"
// if you only check that the stale string is gone. So the routing claims are
// measured ON THE WIRE (tests/fixtures/recordingProvider.mjs), the standing rule
// tests/systems-remote-id.test.mjs sets: a claim about which machine was asked
// is proven by the bytes that crossed the pipe.
//
// THE OTHER HALF IS THE DISCRIMINATOR. "The project no longer resolves" cannot
// tell an unregistration from an unmounted volume — for an in-root project the
// DIRECTORY IS the registration. What can tell them apart is cc's own
// bookkeeping: `deleteProject` removes `projectStoreDir(name)` on all three of
// its branches, and an `rm -rf` of a checkout from under a running server does
// not. So an unregistered project is SKIPPED (`degraded:false`, referencing
// projects keep regenerating), while a checkout that merely vanished DEGRADES
// (`degraded:true`, the never-blanks freeze in ensureProjectConventionsMd
// holds). T2/T3 and T5 are the two sides of that split; if either collapses
// into the other the design is wrong.
//
// THE CACHE-COHERENCE HALF (T6-T10). Resolving the placement live is not enough
// on its own: the fragment BODIES are cached under a (system, target, path) key,
// and two of the triggers above leave that key byte-identical while the machine
// behind it changes. So every cached body carries a LABEL — the state it was
// actually read under — and only a body whose label matches the current state is
// served. Two interleaves prove that the label cannot be dodged: T6 puts a
// degrade between two composes (which discards the memoized result but not the
// bodies), and T10 puts an invalidation INSIDE a scan (so the scan's own later
// inserts are made under a claim that no longer holds). T7-T9 pin the
// classification's safe directions, which no other test reaches.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { git } from './remoteSystem.mjs';
import { waitFor } from './plugin-helpers.mjs';
import { createPluginHost } from '../src/plugins/registry.ts';
import {
  createProject, adoptProject, deleteProject, setProjectRemote, projectStoreDir, orchStoreRoot,
} from '../src/projects.ts';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { setPluginConventionsProvider } from '../src/projectConventions.ts';
import { composeProjectConventionsDoc, ensureProjectConventionsMd, conventionsTargetPath } from '../src/projectClaudeMd.ts';

const RECORDER = path.join(import.meta.dirname, 'fixtures', 'recordingProvider.mjs');
const GATED = path.join(import.meta.dirname, 'fixtures', 'gatedProvider.mjs');
const SLOW_HELLO = path.join(import.meta.dirname, 'fixtures', 'slowHelloProvider.mjs');
const FRAGMENT_REL = path.join('conventions', 'sample.md');

function manifest(id, { claudePlugin } = {}) {
  return {
    id, name: id, version: '1.0.0', pluginApi: 1,
    ...(claudePlugin ? { claudePlugin } : {}),
    conventions: [{ slug: 'frag', name: 'Frag', description: 'x', file: 'conventions/sample.md', scope: 'project' }],
  };
}

// A plugin tree: the manifest, its declared fragment, and optionally a loadable
// Claude Code plugin root (so `claudePluginDirs()` has something real to drop —
// its absence must be the placement's doing, not a missing plugin.json).
async function seedPluginTree(dir, id, body, { claudePlugin } = {}) {
  await fs.mkdir(path.join(dir, 'conventions'), { recursive: true });
  await fs.writeFile(path.join(dir, FRAGMENT_REL), body);
  if (claudePlugin) {
    await fs.mkdir(path.join(dir, claudePlugin, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(dir, claudePlugin, '.claude-plugin', 'plugin.json'), '{"name":"x"}');
  }
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest(id, { claudePlugin }), null, 2));
  return dir;
}

async function seedGitRepo(dir) {
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

const bodyOf = (groups, slug) => groups.project.find(e => e.slug === slug)?.body ?? null;
const isDegraded = (groups) => groups.project.degraded === true;

// Every CLIENT frame the host sent this provider generation, oldest first.
async function frames(record) {
  const raw = await fs.readFile(record, 'utf8').catch(() => '');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

async function fragmentReads(record) {
  return (await frames(record))
    .filter(f => f.type === 'readFile' && typeof f.path === 'string' && f.path.endsWith(FRAGMENT_REL))
    .map(f => ({ path: f.path, remoteId: f.remoteId ?? null }));
}

describe('a plugin fragment follows its project, live', () => {
  let home, host, record;
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    record = path.join(home, 'wire.jsonl');
    host = createPluginHost();
  });
  afterEach(async () => {
    setPluginConventionsProvider(null);
    await host.stopAll();
    disposeSystemHandles();
    await rmrf(home);
  });

  // T1 ─────────────────────────────────────────────────────────────────
  // PINS: a fragment body is read through the project's CURRENT target, and a
  // project whose tree is not on that target contributes nothing — with no
  // rescan, and without the catalog claiming a transient failure.
  //
  // NOT CLAIMING: that bodies are re-read on every compose (the memo stands);
  // that an outage is distinguished from a moved tree; that a byte-DIFFERENT
  // body is served from target `b` — with a fencing provider and distinct roots
  // one absolute path cannot exist on both, so the correct answer after the
  // change is refused-and-skipped. Assertion (4) is what carries the "and it
  // really did ask b" half.
  test('a fragment body follows its project to a new target, with no rescan', async () => {
    const rootA = await fs.realpath(await mkdtemp('cc-remote-a-'));
    const rootB = await fs.realpath(await mkdtemp('cc-remote-b-'));
    const sys = await addSystem({
      id: 'refbox', label: 'Reference box',
      launch: ['node', RECORDER, '--record', record, '--remote', `a=${rootA}`, '--remote', `b=${rootB}`],
    });
    const tree = path.join(rootA, 'convp');
    await createProject('convp', { system: sys.id, remoteId: 'a', systemPath: tree });
    await seedPluginTree(tree, 'remote-plug', 'REMOTE-A CONTENT');

    await host.enable('remote-plug');
    const before = await host.conventions();
    assert.equal(bodyOf(before, 'remote-plug/frag'), 'REMOTE-A CONTENT');
    assert.equal(isDegraded(before), false);

    // Only post-mutation frames may count as evidence of a post-mutation read.
    await fs.writeFile(record, '');
    await setProjectRemote('convp', 'b', { liveInstanceIds: () => [] });

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'remote-plug/frag'), null,
      'the fragment is absent from the catalog — its tree is not on the target the project is now on');
    assert.ok(!JSON.stringify(after).includes('REMOTE-A CONTENT'),
      'and the OLD target\'s bytes appear nowhere in any scope');
    assert.equal(isDegraded(after), false,
      'the far side ANSWERED by name — that is a refusal, not "I cannot tell"');

    const reads = await fragmentReads(record);
    assert.ok(reads.some(r => r.path === path.join(tree, FRAGMENT_REL) && r.remoteId === 'b'),
      `the host asked target 'b' for the fragment: ${JSON.stringify(reads)}`);
  });

  // T2 ─────────────────────────────────────────────────────────────────
  // PINS: an in-root project that is UNREGISTERED stops contributing — fragment
  // body and `--plugin-dir` root alike — at the moment it is unregistered, with
  // no rescan AND with no freeze (`degraded:false`, so a referencing project
  // regenerates without the slug instead of being frozen indefinitely).
  //
  // NOT CLAIMING: that the registry record is purged (it is not — the row goes
  // `invalid` at the next rescan); that the plugin's tree survives (an in-root
  // delete removes it; T3 is the branch where it survives). AND NOT CLAIMING THE
  // `--plugin-dir` HALF: the claudePluginDirs() assertion below passes on the
  // pre-fix code too, because an in-root delete takes the tree with it and the
  // `.claude-plugin/plugin.json` access fails whichever dir the code resolved.
  // It is kept as intent documentation only. **T3 is where that half is
  // actually covered** — its branch leaves the tree, and therefore the stale
  // dir, in place across the delete.
  test('deleting an in-root plugin project stops its contributions, without degrading', async () => {
    const dir = path.join(process.env.PROJECTS_ROOT, 'localplug');
    await fs.mkdir(dir, { recursive: true });
    await seedPluginTree(dir, 'local-plug', 'LOCAL CONTENT', { claudePlugin: 'claude' });

    await host.enable('local-plug');
    const before = await host.conventions();
    assert.equal(bodyOf(before, 'local-plug/frag'), 'LOCAL CONTENT');
    assert.deepEqual(await host.claudePluginDirs(), [path.join(dir, 'claude')]);

    await deleteProject('localplug');

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'local-plug/frag'), null, 'an unregistered project contributes no fragment');
    assert.ok(!JSON.stringify(after).includes('LOCAL CONTENT'), 'and its bytes are in no scope');
    assert.equal(isDegraded(after), false,
      'cc\'s own record and registering artefact are both gone — the most authoritative answer it has');
    assert.deepEqual(await host.claudePluginDirs(), [], 'and no --plugin-dir root names it');
  });

  // T3 ─────────────────────────────────────────────────────────────────
  // PINS: the same, on the branch where the CHECKOUT SURVIVES the delete — an
  // adopted (external) project, whose `.external/<name>` link is unlinked while
  // the user's own repo stays exactly where it was. Strictly stronger than T2:
  // every dir the old liveness re-check watched is still present, so that check
  // provably cannot see this one.
  //
  // NOT CLAIMING: that the tree is deleted (D11 says it is not — asserted).
  test('deleting an adopted plugin project stops its contributions, though its tree survives', async () => {
    const ext = await fs.realpath(await mkdtemp('cc-ext-'));
    await seedPluginTree(ext, 'ext-plug', 'EXTERNAL CONTENT', { claudePlugin: 'claude' });
    await seedGitRepo(ext);
    const adopted = await adoptProject('extplug', ext);
    assert.equal(adopted.ok, true, JSON.stringify(adopted));

    await host.enable('ext-plug');
    const before = await host.conventions();
    assert.equal(bodyOf(before, 'ext-plug/frag'), 'EXTERNAL CONTENT');
    assert.deepEqual(await host.claudePluginDirs(), [path.join(ext, 'claude')]);

    await deleteProject('extplug');
    assert.equal(await fs.readFile(path.join(ext, FRAGMENT_REL), 'utf8'), 'EXTERNAL CONTENT',
      'D11: unregistering an adopted project leaves the user\'s own repo alone');

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'ext-plug/frag'), null,
      'the fragment goes even though every dir the old liveness check watched still exists');
    assert.ok(!JSON.stringify(after).includes('EXTERNAL CONTENT'), 'and its bytes are in no scope');
    assert.equal(isDegraded(after), false);
    assert.deepEqual(await host.claudePluginDirs(), [],
      'and an unregistered project\'s dir is no longer handed to every claude launch');
  });

  // T4 ─────────────────────────────────────────────────────────────────
  // PINS: re-pointing a SYSTEM's provider command re-reads the fragment through
  // the new process. This is the one trigger where the project record, the
  // fragment path and the cache key are all byte-identical before and after,
  // and only the machine behind the id changed — so the only thing that can
  // catch it is the system-handle generation.
  //
  // NOT CLAIMING: a byte-different body (same reason as T1 — the new root
  // fences the old absolute path out, so refused-and-skipped is the correct
  // answer); that a handle is disposed on anything other than an argv change.
  test('re-pointing a system re-reads the fragment through the new provider', async () => {
    const rootC = await fs.realpath(await mkdtemp('cc-remote-c-'));
    const rootD = await fs.realpath(await mkdtemp('cc-remote-d-'));
    const recordC = path.join(home, 'wire-c.jsonl');
    const recordD = path.join(home, 'wire-d.jsonl');
    const sys = await addSystem({
      id: 'swapbox', label: 'Swap box',
      launch: ['node', RECORDER, '--record', recordC, '--remote', `m=${rootC}`],
    });
    const tree = path.join(rootC, 'sw');
    await createProject('sw', { system: sys.id, remoteId: 'm', systemPath: tree });
    await seedPluginTree(tree, 'swap-plug', 'MACHINE-C CONTENT');

    await host.enable('swap-plug');
    assert.equal(bodyOf(await host.conventions(), 'swap-plug/frag'), 'MACHINE-C CONTENT');
    assert.deepEqual(await fragmentReads(recordD), [], 'the second generation has not been spoken to yet');

    await updateSystem(sys.id, {
      launch: ['node', RECORDER, '--record', recordD, '--remote', `m=${rootD}`],
    });

    const after = await host.conventions();
    assert.notEqual(bodyOf(after, 'swap-plug/frag'), 'MACHINE-C CONTENT',
      'the body must not come back from a cache key that is identical while the machine is not');
    assert.ok(!JSON.stringify(after).includes('MACHINE-C CONTENT'), 'in any scope');
    assert.equal(isDegraded(after), false);

    const reads = await fragmentReads(recordD);
    assert.ok(reads.some(r => r.path === path.join(tree, FRAGMENT_REL) && r.remoteId === 'm'),
      `the fragment was re-read through the NEW provider process: ${JSON.stringify(reads)}`);
  });

  // T5 ─────────────────────────────────────────────────────────────────
  // THE GUARD, and the other side of the discriminator. PINS: a checkout that
  // vanished from under a running server while cc's own store state for the
  // project REMAINS is ambiguous — gone or unmounted, cc cannot tell — so it
  // degrades, and the never-blanks freeze in ensureProjectConventionsMd holds.
  // This is what stops a later "simplification" of the unregistered test into
  // "resolveProjectDir returned null", which would silently delete that
  // guarantee for every T2/T3-shaped case.
  //
  // NOT CLAIMING: that the plugin recovers when the checkout returns; that the
  // degraded flag names WHICH plugin failed (it is per-catalog, not per-entry).
  test('a vanished checkout with cc\'s store state intact degrades, and freezes the referencing project', async () => {
    const root = process.env.PROJECTS_ROOT;
    const dir = path.join(root, 'ghostplug');
    await fs.mkdir(dir, { recursive: true });
    await seedPluginTree(dir, 'ghost-plug', 'GHOST CONTENT');

    await host.enable('ghost-plug');
    assert.equal(bodyOf(await host.conventions(), 'ghost-plug/frag'), 'GHOST CONTENT');

    setPluginConventionsProvider(async () => (await host.conventions()).project);
    const doc = await composeProjectConventionsDoc(['ghost-plug/frag', 'design-guidelines']);
    await createProject('referencer', { conventionsDoc: doc });
    const target = conventionsTargetPath(path.join(root, 'referencer'));

    // The CHECKOUT only. cc's own bookkeeping under the store survives, which
    // is exactly what an unmounted volume looks like too.
    await fs.rm(dir, { recursive: true, force: true });
    assert.equal(await fs.stat(projectStoreDir('ghostplug')).then(s => s.isDirectory(), () => false), true,
      'the store dir is the discriminator — it must still be here for this to be the ambiguous case');

    const degraded = await host.conventions();
    assert.equal(bodyOf(degraded, 'ghost-plug/frag'), null, 'the entry drops out');
    assert.equal(degraded.project.degraded, true, 'and the catalog says it cannot vouch for the absence');
    assert.equal(degraded.conductor.degraded, true, 'every scope array is flagged, not just the one that lost an entry');

    const res = await ensureProjectConventionsMd('referencer');
    assert.equal(res.skipped, 'catalog-degraded');
    assert.deepEqual(res.missing, ['ghost-plug/frag']);
    assert.equal(await fs.readFile(target, 'utf8'), doc, 'never blank a slug a degraded catalog cannot vouch for');
  });

  // T6 ─────────────────────────────────────────────────────────────────
  // THE INTERLEAVE. PINS: a fragment body cached under one placement/generation
  // is never served under another, EVEN IF a degraded compose happened in
  // between and threw away the memoized result.
  //
  // T4 looks like it covers this and does not: its fixture has one plugin and a
  // clean memo, so the fingerprint-mismatch drop always has a memo to compare
  // against. A degraded compose is precisely the path that leaves the body cache
  // POPULATED with no memo left, so a drop conditioned on the memo skips exactly
  // when it is most needed — and an argv re-point then serves the OLD machine's
  // body at `degraded:false`, which is this card's own defect back through a
  // reachable window. Hence the fingerprint the bodies were read under is kept
  // separately from the memo.
  //
  // Two plugins, because the degrader must not be the plugin under test: a
  // plugin that degrades contributes nothing, and the claim is about one that
  // contributes a WRONG body while the catalog reads healthy. `disable` is what
  // retires the degrader, chosen because it is documented as deliberately NOT
  // dropping fragment bodies (it only bumps the generation), so it removes the
  // degrade without doing the clearing this test is trying to observe.
  //
  // NOT CLAIMING: that a degraded compose drops bodies itself (it does not, and
  // need not — it leaves them for a fingerprint that still matches); that the
  // memo survives a degrade (it deliberately does not — that is T8's subject).
  test('a body cached before a degraded compose is not served after a system re-point', async () => {
    const rootC = await fs.realpath(await mkdtemp('cc-remote-c-'));
    const rootD = await fs.realpath(await mkdtemp('cc-remote-d-'));
    const recordC = path.join(home, 'wire-c.jsonl');
    const recordD = path.join(home, 'wire-d.jsonl');
    const sys = await addSystem({
      id: 'swapbox', label: 'Swap box',
      launch: ['node', RECORDER, '--record', recordC, '--remote', `m=${rootC}`],
    });
    const tree = path.join(rootC, 'sw');
    await createProject('sw', { system: sys.id, remoteId: 'm', systemPath: tree });
    await seedPluginTree(tree, 'swap-plug', 'MACHINE-C CONTENT');

    // The degrader: local, in-root, and a DIFFERENT plugin.
    const ghostDir = path.join(process.env.PROJECTS_ROOT, 'ghostplug');
    await fs.mkdir(ghostDir, { recursive: true });
    await seedPluginTree(ghostDir, 'ghost-plug', 'GHOST CONTENT');

    await host.enable('swap-plug');
    await host.enable('ghost-plug');

    // 1. Healthy compose — this is what puts MACHINE-C CONTENT in the body cache.
    const healthy = await host.conventions();
    assert.equal(bodyOf(healthy, 'swap-plug/frag'), 'MACHINE-C CONTENT');
    assert.equal(isDegraded(healthy), false);

    // 2. A degraded compose from the OTHER plugin. This is the step that nulls
    //    the memoized result while the body cache keeps MACHINE-C CONTENT.
    await fs.rm(ghostDir, { recursive: true, force: true });
    assert.equal(isDegraded(await host.conventions()), true, 'the interleaved compose really did degrade');

    // 3. Retire the degrader without clearing any body: disable bumps the
    //    generation only.
    await host.disable('ghost-plug');

    // 4. Re-point the system. Record path, remoteId and system id are all
    //    unchanged, so the fragment cache KEY is byte-identical — only the
    //    machine behind it moved.
    await updateSystem(sys.id, {
      launch: ['node', RECORDER, '--record', recordD, '--remote', `m=${rootD}`],
    });

    const after = await host.conventions();
    assert.equal(isDegraded(after), false,
      'the degrade is over — this compose is the healthy one whose answer must still be right');
    assert.notEqual(bodyOf(after, 'swap-plug/frag'), 'MACHINE-C CONTENT',
      'a body cached before the degrade must not survive the re-point that followed it');
    assert.ok(!JSON.stringify(after).includes('MACHINE-C CONTENT'), 'in any scope');

    const reads = await fragmentReads(recordD);
    assert.ok(reads.some(r => r.path === path.join(tree, FRAGMENT_REL) && r.remoteId === 'm'),
      `the fragment was re-read through the NEW provider process: ${JSON.stringify(reads)}`);
  });

  // T7 ─────────────────────────────────────────────────────────────────
  // THE HOISTED GUARD. PINS: when cc's own store ROOT is absent, a project that
  // does not resolve is AMBIGUOUS, never authoritatively unregistered.
  //
  // The unregistered test is "the project does not resolve AND its store dir is
  // gone". Without the third term, a vanished store root satisfies the second
  // for EVERY project at once, so every plugin would read as unregistered and
  // every contribution would be dropped silently at `degraded:false` — a clean,
  // unflagged, empty catalog that referencing projects would then regenerate
  // against. The guard puts that catastrophe in the degrade bucket, where the
  // never-blanks freeze holds instead.
  //
  // A guard, not a red-to-green: it pins behaviour the fix already has, which no
  // other test in the suite reaches.
  //
  // NOT CLAIMING: that cc recovers when the store root returns; that any
  // individual project is or is not registered — with the root gone that
  // question has no local answer, which is the whole point.
  test('a vanished store root degrades rather than declaring every plugin unregistered', async () => {
    const dir = path.join(process.env.PROJECTS_ROOT, 'rootlessplug');
    await fs.mkdir(dir, { recursive: true });
    await seedPluginTree(dir, 'rootless-plug', 'ROOTLESS CONTENT');

    await host.enable('rootless-plug');
    assert.equal(bodyOf(await host.conventions(), 'rootless-plug/frag'), 'ROOTLESS CONTENT');

    // Both halves of the unregistered test now read "gone": no checkout, and no
    // store dir — because the whole store root went with it.
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(orchStoreRoot(), { recursive: true, force: true });

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'rootless-plug/frag'), null, 'the entry drops out either way');
    assert.equal(after.project.degraded, true,
      'but it must drop out DEGRADED — a missing store root is cc losing its own bookkeeping, not the project being unregistered');
    assert.equal(after.conductor.degraded, true, 'every scope array is flagged');
  });

  // T8 ─────────────────────────────────────────────────────────────────
  // PINS: a degraded catalog is not memoized — it recovers on its own once the
  // failure ends, with NO registry mutation, NO project-record change and NO
  // system-handle change to invalidate it.
  //
  // That combination is why the fixture needs a gated provider. Every other
  // route out of a degrade moves the placement fingerprint (a restored checkout
  // flips its artefact token) or the handle generation (an argv swap disposes the
  // handle), so a memoized degraded result would be invalidated by the recovery
  // itself and the rule would look like it held whether it did or not. A box that
  // is simply down and then up again touches neither.
  //
  // NOT CLAIMING: that recovery lands on the immediately-next call —
  // ProviderConnection opens a backoff window after a failed connect and REFUSES
  // inside it rather than queueing, so the retry happens on cc's schedule, which
  // is what `waitFor` here is bounded against. Nor that the body is re-read on
  // recovery: the placement never changed, so the cached body is the right one.
  test('a degraded catalog recovers when the system comes back, with nothing else changing', async () => {
    const root = await fs.realpath(await mkdtemp('cc-remote-gated-'));
    const gate = path.join(home, 'gate');
    const sys = await addSystem({
      id: 'gatedbox', label: 'Gated box',
      launch: ['node', GATED, '--gate', gate, '--remote', `g=${root}`],
    });
    const tree = path.join(root, 'gp');
    await createProject('gp', { system: sys.id, remoteId: 'g', systemPath: tree });
    await seedPluginTree(tree, 'gated-plug', 'GATED CONTENT');

    await host.enable('gated-plug');
    assert.equal(bodyOf(await host.conventions(), 'gated-plug/frag'), 'GATED CONTENT');

    // The box goes down. Nothing about cc's own state changes: the registry row,
    // the project record and the live handle are all untouched.
    await fs.writeFile(gate, '');
    disposeSystemHandles(); // drop the live connection so the next one re-reads the gate
    const down = await host.conventions();
    assert.equal(bodyOf(down, 'gated-plug/frag'), null, 'an unreachable system contributes nothing');
    assert.equal(down.project.degraded, true, 'and says so — this is "I cannot tell", not "it is gone"');

    // The box comes back. No record write, no row edit, no handle disposal.
    await fs.rm(gate);
    const recovered = await waitFor(async () => {
      const g = await host.conventions();
      return g.project.degraded !== true && bodyOf(g, 'gated-plug/frag') !== null ? g : false;
    }, { timeout: 8000, interval: 25 });
    assert.equal(bodyOf(recovered, 'gated-plug/frag'), 'GATED CONTENT',
      'the catalog is healthy again without any gesture that could have invalidated a memo');
  });

  // T9 ─────────────────────────────────────────────────────────────────
  // PINS: the store-dir half of the discriminator treats only ENOENT as "gone".
  // Any other fs error means cc could not tell, which must degrade — never
  // classify a registered project as authoritatively unregistered.
  //
  // `existsSync` answers false on ANY error, so it cannot make that distinction
  // at all: an unreadable store dir would read as gone and drop the project's
  // contributions silently at `degraded:false`. The error is provoked with
  // ENOTDIR — a FILE where the store's `projects/` directory belongs, so
  // stat(`<store>/projects/<name>`) fails with something that is not ENOENT —
  // because that needs no permission games and is identical on any host,
  // including one running as root.
  //
  // NOT CLAIMING: that EACCES specifically is handled (it is the same branch, but
  // this fixture provokes ENOTDIR); that the store is repaired or the project
  // recovers.
  test('an unreadable store dir degrades rather than reading as unregistered', async () => {
    const dir = path.join(process.env.PROJECTS_ROOT, 'enotdirplug');
    await fs.mkdir(dir, { recursive: true });
    await seedPluginTree(dir, 'enotdir-plug', 'ENOTDIR CONTENT');

    await host.enable('enotdir-plug');
    assert.equal(bodyOf(await host.conventions(), 'enotdir-plug/frag'), 'ENOTDIR CONTENT');

    // The checkout is gone, so classification reaches the store-dir test — and
    // that test now hits a path whose parent is a file, not a missing entry.
    await fs.rm(dir, { recursive: true, force: true });
    const projectsStoreDir = path.dirname(projectStoreDir('enotdirplug'));
    await fs.rm(projectsStoreDir, { recursive: true, force: true });
    await fs.writeFile(projectsStoreDir, 'not a directory');

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'enotdir-plug/frag'), null, 'the entry drops out either way');
    assert.equal(after.project.degraded, true,
      'an fs error cc cannot interpret must not read as "this project was unregistered"');
  });

  // T10 ────────────────────────────────────────────────────────────────
  // THE MID-SCAN INTERLEAVE. PINS: a body inserted into the fragment cache by a
  // scan whose cache claim was VOIDED WHILE IT RAN is never served afterwards.
  //
  // T6's interleave puts the degrade BETWEEN two composes, so the label is whole
  // when each scan starts. This one puts an `invalidate()` INSIDE a scan: a scan
  // reads and inserts over its whole duration, so anything that voids the scan's
  // claim after it began leaves that scan's own later inserts unaccounted for.
  // `enable` (and `rescan`, `doStart`, `setActiveVersion`) all invalidate, all
  // are ordinary HTTP routes, and a compose runs concurrently with them over
  // real wire I/O — so this window is production-reachable, not an artefact of
  // the fixture.
  //
  // The instrument parks the compose inside `resolvePlacement`'s connect, which
  // is the only place a compose blocks long enough to be interrupted on purpose.
  // `enable`'s clear is what makes the post-park read a genuinely fresh one
  // rather than a cache hit, so the body that reaches the cache is inserted
  // strictly after the invalidation.
  //
  // NOT CLAIMING THE MECHANISM, only the observable contract: it asserts the
  // stale body is not served, not that this is achieved by refusing the insert
  // rather than sweeping it afterwards. It also does not claim the interrupted
  // compose's own RESULT is discarded — the generation snapshot already marks it
  // stale, which is separate and older — nor that the wasted re-read a mid-scan
  // invalidation causes is avoided (it is not; correctness first).
  test('a body inserted by a scan that was invalidated mid-flight is not served afterwards', async () => {
    const rootC = await fs.realpath(await mkdtemp('cc-remote-park-c-'));
    const rootD = await fs.realpath(await mkdtemp('cc-remote-park-d-'));
    const release = path.join(home, 'release');
    const parked = `${release}.parked`;
    // Released to begin with, so registration, discovery and the first compose
    // all run at full speed.
    await fs.writeFile(release, '');

    const sys = await addSystem({
      id: 'parkbox', label: 'Park box',
      launch: ['node', SLOW_HELLO, '--release', release, '--remote', `m=${rootC}`],
    });
    const tree = path.join(rootC, 'sw');
    await createProject('sw', { system: sys.id, remoteId: 'm', systemPath: tree });
    await seedPluginTree(tree, 'swap-plug', 'MACHINE-C CONTENT');

    // The invalidator: a second, local plugin, enabled LATER. Its project sorts
    // after 'sw', so it cannot be the entry the scan parks on.
    const secondDir = path.join(process.env.PROJECTS_ROOT, 'zsecond');
    await fs.mkdir(secondDir, { recursive: true });
    await seedPluginTree(secondDir, 'second-plug', 'SECOND CONTENT');

    await host.enable('swap-plug');
    assert.equal(bodyOf(await host.conventions(), 'swap-plug/frag'), 'MACHINE-C CONTENT');

    // Park the NEXT connect: drop the live connection and shut the gate, so the
    // compose below blocks in the handshake instead of reusing a live handle.
    disposeSystemHandles();
    await fs.rm(release);

    const inflight = host.conventions();
    await waitFor(() => fs.stat(parked).then(() => true, () => false), { timeout: 8000, interval: 10 });

    // MID-SCAN. enable() invalidates: it clears the fragment bodies and voids
    // whatever claim the parked scan is holding over them.
    await host.enable('second-plug');

    // Let the parked scan finish. Its read of the fragment lands strictly after
    // the invalidation, into a cache that was just emptied.
    await fs.writeFile(release, '');
    const resumed = await inflight;
    assert.equal(bodyOf(resumed, 'swap-plug/frag'), 'MACHINE-C CONTENT',
      'precondition: the interrupted scan really did read and cache the body after the invalidation');

    // Now move the machine behind the id, leaving system id, remoteId and path
    // byte-identical — so only a correctly-labelled cache can answer this.
    await updateSystem(sys.id, {
      launch: ['node', SLOW_HELLO, '--release', release, '--remote', `m=${rootD}`],
    });

    const after = await host.conventions();
    assert.equal(isDegraded(after), false, 'this compose is healthy — its answer must still be right');
    assert.notEqual(bodyOf(after, 'swap-plug/frag'), 'MACHINE-C CONTENT',
      'a body cached by a scan that was invalidated mid-flight must not survive a later re-point');
    assert.ok(!JSON.stringify(after).includes('MACHINE-C CONTENT'), 'in any scope');
  });
});
