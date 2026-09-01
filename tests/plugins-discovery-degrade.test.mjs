// A DISCOVERY SCAN THAT COULD NOT REACH A PROJECT SAYS SO — card 2026-0272.
//
// `rescanInternal` resolves every project through its own System and, when that
// resolution fails, drops the project with a `console.warn` and a `continue`.
// The project contributes no plugin for the whole life of that catalog, and
// nothing marked the result degraded: `conventions()` returned a CLEAN,
// UNFLAGGED catalog that was silently missing that plugin's fragments, so
// `ensureProjectConventionsMd` read the slug as confirmed-absent and REWROTE
// every referencing project's committed `CONVENTIONS.md` without it.
//
// The same outage seen during a COMPOSE already degraded the catalog and froze
// the write (tests/plugins-placement-live.test.mjs T5/T8). One condition, two
// policies — and the scan-time one was the less conservative of the pair.
//
// WHAT THE SCAN CAN AND CANNOT ESTABLISH, because it is what every claim here
// is bounded by. The compose loop applies five filters before it degrades;
// four of them (`discoveryState === 'ok'`, a string id, a non-null manifest,
// a non-empty `conventions` list) are read out of the manifest, which is
// exactly the file the unreachable box withheld. The fifth — is there an
// ENABLED persisted record for this plugin — is on cc's own disk. So the
// scan-time flag is raised on that one term alone, and it is a strict
// SUPERSET of the compose-time one: D8 pins that difference as real behaviour
// rather than leaving it as prose.
//
// A NEW FILE rather than additions to plugins-placement-live.test.mjs: that
// file's reds name the LIVE-PLACEMENT mechanism, and a red here must name the
// DISCOVERY-TIME one. Its T5/T8 are guard tests for this card — green before,
// green after, unedited.
//
// The fixture is tests/fixtures/gatedProvider.mjs, the same real provider that
// file uses: a box that is simply down, with cc's registry row, project record
// and live handle all untouched. Nothing here is shimmed or injected — the
// production path a downed box takes is the path under test.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { waitFor } from './plugin-helpers.mjs';
import { createPluginHost } from '../src/plugins/registry.ts';
import { createProject, deleteProject, projectStoreDir } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { setPluginConventionsProvider } from '../src/projectConventions.ts';
import { composeProjectConventionsDoc, ensureProjectConventionsMd, conventionsTargetPath } from '../src/projectClaudeMd.ts';

const GATED = path.join(import.meta.dirname, 'fixtures', 'gatedProvider.mjs');
const FRAGMENT_REL = path.join('conventions', 'sample.md');

function manifest(id) {
  return {
    id, name: id, version: '1.0.0', pluginApi: 1,
    conventions: [{ slug: 'frag', name: 'Frag', description: 'x', file: 'conventions/sample.md', scope: 'project' }],
  };
}

// A manifest declaring NO conventions at all — valid, enableable, and the one
// shape the compose loop skips before it can ever degrade (D8).
function bareManifest(id) {
  return { id, name: id, version: '1.0.0', pluginApi: 1 };
}

async function seedPluginTree(dir, m, body) {
  await fs.mkdir(path.join(dir, 'conventions'), { recursive: true });
  await fs.writeFile(path.join(dir, FRAGMENT_REL), body);
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(m, null, 2));
  return dir;
}

const bodyOf = (groups, slug) => groups.project.find(e => e.slug === slug)?.body ?? null;
const isDegraded = (groups) => groups.project.degraded === true;

describe('a discovery scan that could not reach a project says so', () => {
  let home, host, gate, boxRoot, boxSys;

  // The box is down for cc only while the gate file exists; dropping the live
  // handle is what makes the next connection re-read it (an argv-carried gate
  // would dispose the handle by itself and destroy what is being measured —
  // see the fixture's own header).
  async function boxDown() {
    await fs.writeFile(gate, '');
    disposeSystemHandles();
  }
  async function boxUp() {
    await fs.rm(gate);
  }

  // A project on the gated box, created while the box is still up.
  async function boxProject(name) {
    const tree = path.join(boxRoot, name);
    await createProject(name, { system: boxSys.id, remoteId: 'g', systemPath: tree });
    return tree;
  }

  // An in-root project, made the way T2 in plugins-placement-live.test.mjs
  // makes one: a bare mkdir, which is all an in-root project IS.
  async function localProject(name) {
    const dir = path.join(process.env.PROJECTS_ROOT, name);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  // A project whose committed CONVENTIONS.md carries `slugs`, plus the exact
  // bytes it was written with — the thing a rewrite would change.
  async function referencer(name, slugs) {
    setPluginConventionsProvider(async () => (await host.conventions()).project);
    const doc = await composeProjectConventionsDoc(slugs);
    await createProject(name, { conventionsDoc: doc });
    const target = conventionsTargetPath(path.join(process.env.PROJECTS_ROOT, name));
    assert.equal(await fs.readFile(target, 'utf8'), doc, 'the referencing file starts out as composed');
    return { doc, target };
  }

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    boxRoot = await fs.realpath(await mkdtemp('cc-gated-box-'));
    gate = path.join(home, 'gate');
    boxSys = await addSystem({
      id: 'gatedbox', label: 'Gated box',
      launch: ['node', GATED, '--gate', gate, '--remote', `g=${boxRoot}`],
    });
    host = createPluginHost();
  });
  afterEach(async () => {
    setPluginConventionsProvider(null);
    await host.stopAll();
    disposeSystemHandles();
    await rmrf(home);
    await rmrf(boxRoot);
  });

  // D1 ─────────────────────────────────────────────────────────────────
  // PINS: a project skipped by a RESCAN because its System was unreachable,
  // and holding an enabled plugin, leaves the catalog flagged degraded — so
  // the never-blanks freeze in ensureProjectConventionsMd holds and the
  // referencing project's committed file is byte-identical afterwards.
  //
  // NOT CLAIMING: that the flag names WHICH project was unreachable (it is
  // per-catalog, not per-entry); that the catalog recovers when the box comes
  // back without a rescan (it does not — D5 is the recovery shape); that
  // anything about the compose-time degrade changed.
  test('a rescan that could not reach an enabled plugin\'s project degrades, and freezes the referencing project', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, manifest('gated-plug'), 'GATED CONTENT');
    await host.enable('gated-plug');
    assert.equal(bodyOf(await host.conventions(), 'gated-plug/frag'), 'GATED CONTENT');

    const { doc, target } = await referencer('referencer', ['gated-plug/frag', 'design-guidelines']);

    await boxDown();
    await host.rescan();

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'gated-plug/frag'), null, 'the skipped project contributes no fragment');
    assert.equal(after.project.degraded, true,
      'and the catalog says the scan could not establish that absence');
    assert.equal(after.conductor.degraded, true, 'every scope array is flagged, not just the one that lost an entry');

    const res = await ensureProjectConventionsMd('referencer');
    assert.equal(res.skipped, 'catalog-degraded');
    assert.deepEqual(res.missing, ['gated-plug/frag']);
    assert.equal(await fs.readFile(target, 'utf8'), doc,
      'the committed file is byte-identical — a box briefly down must not rewrite it');
  });

  // D2 ─────────────────────────────────────────────────────────────────
  // PINS: the same, when the FIRST scan a host ever runs is the one that
  // cannot reach the box. This is the case no "retain the previous scan's
  // entry" shape could ever cover — at boot there is no previous entry — and
  // it is the likeliest real occurrence, since a server restart during an
  // outage runs regenerateAllProjectConventions across every project.
  //
  // NOT CLAIMING: that the boot fan-out itself is exercised here (this drives
  // ensureProjectConventionsMd directly, as D1 does); that a restart preserves
  // any in-memory state — the point is precisely that it does not.
  test('a host whose FIRST scan cannot reach the box degrades, and freezes the referencing project', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, manifest('gated-plug'), 'GATED CONTENT');
    await host.enable('gated-plug');
    const { doc, target } = await referencer('referencer', ['gated-plug/frag', 'design-guidelines']);

    await boxDown();
    // A fresh process would come up exactly here: the persisted registry.json
    // is on disk, the box is down, and nothing has been scanned yet.
    await host.stopAll();
    host = createPluginHost();
    setPluginConventionsProvider(async () => (await host.conventions()).project);

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'gated-plug/frag'), null);
    assert.equal(after.project.degraded, true, 'the first scan of a fresh host degrades just as a rescan does');

    const res = await ensureProjectConventionsMd('referencer');
    assert.equal(res.skipped, 'catalog-degraded');
    assert.equal(await fs.readFile(target, 'utf8'), doc, 'the committed file is byte-identical across a restart');
  });

  // D3 ─────────────────────────────────────────────────────────────────
  // PINS: the narrowing. A skipped project the store holds no plugin record
  // for does NOT degrade the catalog — it has never contributed a fragment to
  // any committed CONVENTIONS.md, so its absence cannot drop a line from one,
  // and flagging on it would freeze every referencing project over a project
  // that contributes nothing.
  //
  // THE TOPOLOGY IS THE TEST: the gated box hosts EXACTLY ONE project, the
  // plain non-plugin one, and the contributing plugin sits on a project that
  // stays reachable throughout. Any topology where the plugin's own project is
  // also unreachable cannot observe the narrowing at all — the flag would be
  // raised by the plugin's project either way.
  //
  // NOT CLAIMING: that a skipped project with a DISABLED record does not
  // degrade (it does not — D4 covers that direction, via the same predicate);
  // nor a red before the fix — like D6 this is a guard ON the narrowing, and it
  // passed on the unfixed source, where nothing degraded at all. What it stops
  // is a later widening of the read to "any skipped project".
  test('a skipped project the store holds no plugin record for does not degrade the catalog', async () => {
    const dir = await localProject('localplug');
    await seedPluginTree(dir, manifest('local-plug'), 'LOCAL CONTENT');
    await boxProject('plainp'); // on the gated box, no manifest, no plugin, no record
    await host.enable('local-plug');
    assert.equal(bodyOf(await host.conventions(), 'local-plug/frag'), 'LOCAL CONTENT');

    const { doc, target } = await referencer('referencer', ['local-plug/frag', 'design-guidelines']);

    await boxDown();
    await host.rescan();

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'local-plug/frag'), 'LOCAL CONTENT',
      'the reachable plugin project is unaffected by the unreachable one');
    assert.equal(isDegraded(after), false,
      'and the catalog is healthy — the only skipped project holds no plugin record');

    const res = await ensureProjectConventionsMd('referencer');
    assert.equal(res.skipped, undefined);
    assert.equal(await fs.readFile(target, 'utf8'), doc,
      'the referencing project regenerates byte-identical rather than freezing');
  });

  // D4 ─────────────────────────────────────────────────────────────────
  // PINS: the flag must not outlive the reason for it. It is computed against
  // the store on every call rather than latched into a stored boolean, so
  // DISABLING the affected plugin clears it with no rescan — the box is still
  // down, and there is nothing left to protect, because a disabled plugin's
  // slug already drops from a committed file by design.
  //
  // NOT CLAIMING: that re-enabling re-raises it (the record is what the read
  // consults, so it would — but that is not asserted here); that the store
  // record is purged by disable (it is not).
  test('disabling the affected plugin clears the degrade with no rescan, while the box stays down', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, manifest('gated-plug'), 'GATED CONTENT');
    await host.enable('gated-plug');

    await boxDown();
    await host.rescan();
    assert.equal(isDegraded(await host.conventions()), true);

    await host.disable('gated-plug');

    assert.equal(await fs.stat(gate).then(() => true, () => false), true,
      'the box is still down — nothing about reachability changed');
    assert.equal(isDegraded(await host.conventions()), false,
      'the degrade is computed from the live store, not latched by the scan that raised it');
  });

  // D5 ─────────────────────────────────────────────────────────────────
  // PINS: recovery is a RESCAN. The flag is latched to the last completed
  // scan, so a box coming back does not clear it on its own; a rescan does,
  // and the fragment returns with it.
  //
  // NOT CLAIMING: that the rescan succeeds on the immediately-next call —
  // ProviderConnection opens a backoff window after a failed connect and
  // refuses inside it, which is what the waitFor here is bounded against. Nor
  // that the pre-rescan call is the ONLY thing keeping the flag up: with the
  // box back and the plugin gone from the catalog, a compose could not have
  // re-read it either.
  test('a rescan after the box comes back clears the degrade and restores the fragment', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, manifest('gated-plug'), 'GATED CONTENT');
    await host.enable('gated-plug');
    const { doc, target } = await referencer('referencer', ['gated-plug/frag', 'design-guidelines']);

    await boxDown();
    await host.rescan();
    assert.equal(isDegraded(await host.conventions()), true);

    await boxUp();
    const recovered = await waitFor(async () => {
      await host.rescan();
      const g = await host.conventions();
      return g.project.degraded !== true && bodyOf(g, 'gated-plug/frag') !== null ? g : false;
    }, { timeout: 15000, interval: 50 });
    assert.equal(bodyOf(recovered, 'gated-plug/frag'), 'GATED CONTENT');

    const res = await ensureProjectConventionsMd('referencer');
    assert.equal(res.skipped, undefined);
    assert.equal(await fs.readFile(target, 'utf8'), doc, 'and the referencing project regenerates unchanged');
  });

  // D6 ─────────────────────────────────────────────────────────────────
  // PINS: an authoritatively-unregistered project still does not degrade. The
  // scan iterates listProjects(), which IS the registration enumeration, so a
  // deleted project is never skipped by it — it is simply absent.
  //
  // AND THE MEASUREMENT THAT MADE THIS SITE DIFFERENT: the assertion below is
  // that `projectStoreDir(name)` does NOT exist for a healthy, freshly-created
  // in-root project. Card 2026-0263's discriminator reads a missing store dir
  // as "authoritatively unregistered", so importing that discriminator into
  // discovery would classify a live project as unregistered and drop its
  // contributions at `degraded:false` — not merely unreachable here, but
  // actively wrong.
  //
  // NOT CLAIMING: a red before the fix — this is a guard on the fix's
  // narrowing, and it passed on the unfixed source too. What it stops is a
  // later widening of the read to "any enabled record" or to a store-dir test.
  test('an unregistered project is absent from the scan, not skipped by it, and does not degrade', async () => {
    const dir = await localProject('localplug');
    await seedPluginTree(dir, manifest('local-plug'), 'LOCAL CONTENT');
    assert.equal(await fs.stat(projectStoreDir('localplug')).then(() => true, () => false), false,
      'a healthy in-root project has NO store dir — which is why 2026-0263\'s discriminator cannot be reused here');

    await host.enable('local-plug');
    assert.equal(bodyOf(await host.conventions(), 'local-plug/frag'), 'LOCAL CONTENT');

    await deleteProject('localplug');
    await host.rescan();

    const after = await host.conventions();
    assert.equal(bodyOf(after, 'local-plug/frag'), null, 'an unregistered project contributes no fragment');
    assert.equal(isDegraded(after), false,
      'cc\'s own enumeration no longer lists it — that is authoritative, not a failure to reach it');
  });

  // D7 ─────────────────────────────────────────────────────────────────
  // PINS: the row shown for a project that did not resolve at the last scan
  // no longer claims the project or its manifest is gone. It names the
  // resolution failure, carries the resolver's own reason verbatim, and names
  // Rescan as the retry — which, with the degrade latched to the scan, is the
  // user's only cue that Rescan is what clears the freeze.
  //
  // NOT CLAIMING: that the row's `state` changed (it stays `invalid`); that
  // the string distinguishes an unreachable box from a broken project record
  // (it deliberately does not — the resolver's own text is what carries that);
  // that a genuinely-gone project's row changed — plugins-registry.test.mjs
  // covers that case and is unedited, which makes it the guard that this
  // string cannot leak into it.
  test('the row for a project unreachable at the last scan names the resolution failure, not a gone project', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, manifest('gated-plug'), 'GATED CONTENT');
    await host.enable('gated-plug');

    await boxDown();
    await host.rescan();

    const row = (await host.list()).find(r => r.id === 'gated-plug');
    assert.ok(row, 'the store record still deserves a row');
    const err = row.errors[0] ?? '';
    assert.match(err, /did not resolve at the last discovery scan/);
    assert.match(err, /manifest was not read/);
    assert.match(err, /Rescan to retry/);
    assert.ok(!/no longer present/.test(err),
      `the row must not claim the project or manifest is gone: ${err}`);
  });

  // D8 ─────────────────────────────────────────────────────────────────
  // PINS: the documented policy difference is REAL BEHAVIOUR, not just prose.
  // An enabled plugin whose manifest declares no conventions is skipped by the
  // compose loop before it can degrade anything — but at scan time, with the
  // box down, the manifest is exactly what was not read, so the flag is raised
  // on the enabled record alone. Both halves are asserted in one run, on one
  // fixture, so the difference cannot be read as a fixture artefact.
  //
  // This is deliberately over-flagging: over-flagging costs a freeze that the
  // next Rescan clears, under-flagging rewrites a committed file. It is here
  // to stop a later author "tightening" the narrowing with a declares-any-
  // conventions term — a persisted record is `{project, enabled,
  // activeVersion}` and nothing else, so no such term exists at this site.
  //
  // NOT CLAIMING: that the freeze is desirable for this plugin in particular
  // (had the box been up it would have contributed nothing); that the store
  // could not be TAUGHT such a term, only that it holds none today.
  test('a no-conventions plugin degrades at scan time though it never could at compose time', async () => {
    const tree = await boxProject('barep');
    await seedPluginTree(tree, bareManifest('bare-plug'), 'UNUSED');
    await host.enable('bare-plug');
    assert.equal(isDegraded(await host.conventions()), false);

    await boxDown();
    assert.equal(isDegraded(await host.conventions()), false,
      'COMPOSE side: the entry is skipped for declaring no conventions before placement is ever resolved');

    await host.rescan();
    assert.equal(isDegraded(await host.conventions()), true,
      'SCAN side: the manifest was never read, so the flag is raised on the enabled record alone');
  });
});
