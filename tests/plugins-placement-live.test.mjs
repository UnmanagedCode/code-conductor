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

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { git } from './remoteSystem.mjs';
import { createPluginHost } from '../src/plugins/registry.ts';
import {
  createProject, adoptProject, deleteProject, setProjectRemote, projectStoreDir,
} from '../src/projects.ts';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { setPluginConventionsProvider } from '../src/projectConventions.ts';
import { composeProjectConventionsDoc, ensureProjectConventionsMd, conventionsTargetPath } from '../src/projectClaudeMd.ts';

const RECORDER = path.join(import.meta.dirname, 'fixtures', 'recordingProvider.mjs');
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
  // delete removes it; T3 is the branch where it survives).
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
});
