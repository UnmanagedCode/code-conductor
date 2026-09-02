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
import { createProject, deleteProject, projectStoreDir, tryResolveProject } from '../src/projects.ts';
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

  // THE BOX IS REACHABLE AGAIN, ESTABLISHED BY MEASUREMENT RATHER THAN BY
  // ELAPSED TIME. Returns only once the project resolves through its System AND
  // a real file has been read back through the handle that resolution produced.
  //
  // Both halves matter to the caller. Removing the gate file is not enough to
  // make cc able to reach the box: the connection that failed during the
  // down-phase is still cached with its failure count, and it REFUSES inside
  // its own retry window without ever contacting the provider. Any assertion
  // taken in that window cannot tell "the flag is latched" from "a live probe
  // was refused by a backoff" — the two answers are identical. Dropping the
  // handles retires that connection so the next one is fresh, and the wait then
  // runs the exact resolution rescanInternal runs until it genuinely succeeds.
  //
  // WHAT THIS PERTURBS, stated rather than implied: disposing handles moves the
  // placement fingerprint, so it invalidates any memoized conventions() result.
  // It touches NEITHER term the discovery flag is computed from — not the
  // recorded unreachable set, not the store — and it does not rescan. It also
  // leaves the handle WARM, so a read taken immediately after does not pay a
  // reconnect it could mistake for an outage.
  async function boxVerifiablyReachable(project, manifestPath) {
    disposeSystemHandles();
    await waitFor(async () => {
      const { system } = await tryResolveProject(project);
      if (!system) return false;
      return (await system.readFile(manifestPath)).includes('"id"');
    }, { timeout: 15000, interval: 25 });
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
  // PINS BOTH HALVES OF THE LATCH, in order. First: THE DEGRADE OUTLIVES THE
  // CONNECTION'S RETRY WINDOW — a read taken once the box is VERIFIABLY
  // reachable again, with no rescan in between, still reads degraded. Second:
  // a rescan does clear it, and the fragment returns with it.
  //
  // The first assertion carries the design decision, and it is the ONLY place
  // in this file that can: everywhere else the box is still down when the flag
  // is read, so a read-time re-probe would answer "unreachable" and agree with
  // the latch. This is the one moment where the two implementations must give
  // different answers.
  //
  // Where it is taken is therefore the whole of its value. Asserting straight
  // after the gate file is removed
  // proves nothing: the connection that failed during the down-phase is still
  // cached and refuses inside its own retry window, so a read-time re-probe —
  // the shape this exists to rule out — answers "cannot reach it" honestly and
  // is indistinguishable from a latch. Mutation-measured: that is exactly how
  // the earlier version of this assertion passed. boxVerifiablyReachable()
  // closes it by establishing reachability through a real resolution and read
  // first, so a re-probe would have to succeed.
  //
  // NOT CLAIMING: that the rescan succeeds on the immediately-next call (the
  // waitFor below is bounded against a fresh connect, not asserted to be
  // instant). NOT claiming the compose loop was in a position to re-probe
  // anything here: the plugin is out of the catalog by then, so the only thing
  // a read-time probe could consult is the recorded unreachable set — which is
  // precisely what this pins is never consulted for liveness. And NOT claiming
  // anything about how long the retry window is; the point of measuring
  // reachability instead of sleeping is that this test does not know or care.
  test('a rescan after the box comes back clears the degrade and restores the fragment', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, manifest('gated-plug'), 'GATED CONTENT');
    await host.enable('gated-plug');
    const { doc, target } = await referencer('referencer', ['gated-plug/frag', 'design-guidelines']);

    await boxDown();
    await host.rescan();
    assert.equal(isDegraded(await host.conventions()), true);

    await boxUp();
    await boxVerifiablyReachable('gp', path.join(tree, 'conductor.plugin.json'));

    // THE LATCH, AT A MOMENT WHEN A RE-PROBE WOULD HAVE SUCCEEDED. The line
    // above just resolved this project through its System and read its manifest
    // back, on a warm handle, so "cannot reach it" is not available as an
    // answer here. Nothing has rescanned, so the recorded unreachable set is
    // untouched — and the flag is still up.
    assert.equal(isDegraded(await host.conventions()), true,
      'the degrade outlives the connection\'s retry window: it is latched to the last completed scan, not re-derived from reachability at read time');

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
  // WHAT IT ACTUALLY DISCRIMINATES, stated narrowly because the obvious
  // reading is wider than the test: it stops the flag being raised on "there
  // is an enabled record" alone. Here the store still holds the enabled record
  // for local-plug after the delete, and the catalog must stay healthy anyway,
  // because the recorded unreachable set is EMPTY — the project left the
  // enumeration rather than failing to resolve inside it.
  //
  // IT DOES NOT GUARD THE DISCRIMINATOR ITSELF. Mutation-measured: a store-dir
  // term added to the read is never once evaluated during this test, because
  // the empty-set early return short-circuits before any per-record term runs.
  // A change that imports card 2026-0263's discriminator while keeping that
  // early return is caught by D1/D2/D4/D5/D8, not here. What this test kills is
  // the aggressive form that drops the early return as well.
  //
  // THE MEASUREMENT BELOW IS STILL WORTH PINNING, as the reason that
  // discriminator has no future at this site: `projectStoreDir(name)` does NOT
  // exist for a healthy, freshly-created in-root project. Card 2026-0263 reads
  // a missing store dir as "authoritatively unregistered", so the same term
  // here would classify a LIVE project as unregistered and drop its
  // contributions at `degraded:false` — not merely unreachable at this site,
  // but actively wrong.
  //
  // NOT CLAIMING: a red before the fix — this is a guard on the fix's
  // narrowing, and it passed on the unfixed source too.
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
  // the WRAPPER distinguishes an unreachable System from a broken project
  // record (it deliberately does not — the reason it carries is what does,
  // which is why the reason is asserted below rather than taken on trust);
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

    // AND THE REASON ITSELF, which is the only thing in the string that tells
    // an unreachable System apart from a broken project record — the template
    // clauses above are identical for both. A regression dropping the
    // interpolation leaves an empty slot and still satisfies them.
    const reason = err.match(/manifest was not read: (.+)\. Rescan to retry\.$/)?.[1];
    assert.ok(reason, `the resolver's own reason must be carried, not an empty slot: ${err}`);
    assert.match(reason, /is on system 'gatedbox', which cannot be reached/,
      'and carried verbatim: the system id appears nowhere in the wrapper, so its presence is proof the resolver\'s text was passed through');
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
  // next Rescan clears, under-flagging rewrites a committed file.
  //
  // NOT THE SOLE SENTINEL FOR THAT, though it reads like one. Mutation-measured:
  // no declares-any-conventions term can actually distinguish this fixture from
  // D1's contributing one at scan time, because the entry leaves `byId` with
  // the same swap that records the unreachable set — so any such term reads
  // uniformly false, the flag collapses entirely, and D1/D2/D5 die alongside
  // this test. What is unique here is the FIXTURE, not the kill: it is the only
  // place where compose-time and scan-time are made to disagree about one
  // plugin in one run, which is what turns the documented difference into an
  // observation.
  //
  // NOT CLAIMING: that the freeze is desirable for this plugin in particular
  // (had the project resolved it would have contributed nothing); that the
  // store could not be TAUGHT such a term, only that it holds none today.
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

  // D9 ─────────────────────────────────────────────────────────────────
  // PINS WHAT D5 STRUCTURALLY CANNOT: the latch holds across recovery even
  // when NOTHING OBSERVED IT DURING THE OUTAGE. Between the failed rescan and
  // the box becoming verifiably reachable there is no `conventions()` call at
  // all, so the FIRST read of the flag in this scan's state is taken after
  // recovery — and it must still be degraded.
  //
  // D5 cannot reach this. Its during-outage read is load-bearing for what D5
  // pins (that the flag survives the transition), but it also means D5's first
  // read in this set-state happens while the box is down. Any implementation
  // that re-probes ONCE and remembers the answer therefore agrees with the
  // latch in D5 forever, and in D4, and everywhere else in this file — every
  // other case reads the flag during the outage and seeds that answer. This
  // case withholds the observation, which is the only way to tell a latch from
  // a remembered probe.
  //
  // It is the shape D-P0272-1(b) bans by name — "probe on the first compose
  // after a degrade" — and its failure mode is this card's original defect
  // rather than a milder one: a referencing project whose first read lands
  // after the box is back would get a healthy catalog and have its committed
  // CONVENTIONS.md rewritten. That outcome is asserted here, not just the flag.
  //
  // NOT CLAIMING: that no re-probing shape survives this file. A probe keyed on
  // wall-clock time, or throttled to every Nth call, or deriving reachability
  // from something other than resolving the project, is not addressed by this
  // test or by D5. Nor does this pin behaviour when one recorded project
  // recovers while another stays down — the flag is per-catalog and no case
  // here splits it. And no red preceded it: like D5's moved assertion it pins
  // behaviour the fix already has, so there was nothing to watch fail.
  test('the latch holds across recovery when nothing read the flag during the outage', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, manifest('gated-plug'), 'GATED CONTENT');
    await host.enable('gated-plug');
    const { doc, target } = await referencer('referencer', ['gated-plug/frag', 'design-guidelines']);

    await boxDown();

    // ── THE WINDOW OPENS HERE, AND IS COUNTED RATHER THAN ASSUMED ──
    // This test's entire value rests on the ABSENCE of a `conventions()` call
    // from the moment the scan records 'gp' until the box is back. That is
    // invisible in the source below and would be silently undone by a future
    // edit slipping a read in — the same green-for-the-wrong-reason hazard D5
    // already paid for. It starts before the rescan because rescanInternal
    // swaps the recorded set in at its END: a read taken by the rescan itself
    // would land in the new state, during the outage, and seed exactly the
    // answer this test withholds. The counter goes through the host object, so
    // a read taken via the conventions provider (how ensureProjectConventionsMd
    // reaches it) counts too.
    const realConventions = host.conventions;
    let readsInWindow = 0;
    host.conventions = (...a) => { readsInWindow++; return realConventions.apply(host, a); };

    await host.rescan();

    // THE PRECONDITION, TAKEN WITHOUT READING THE FLAG. Something must confirm
    // the scan really did drop 'gp', or this test could pass vacuously against
    // a box that never went down. The store-only row reads the recorded
    // unreachable set directly and never reaches discoveryDegraded() (row.ts
    // builds its fields from the manifest), so it answers that question
    // without spending the one observation this test exists to withhold.
    const row = (await host.list()).find(r => r.id === 'gated-plug');
    assert.match(row?.errors[0] ?? '', /did not resolve at the last discovery scan/,
      'the scan recorded the project as unresolved — established off the row, not off the flag');

    await boxUp();
    await boxVerifiablyReachable('gp', path.join(tree, 'conductor.plugin.json'));

    // ── THE WINDOW CLOSES HERE ── and the count is the proof that the rescan,
    // the row read and the reachability probe above all left the flag
    // unobserved, rather than that being taken on trust from reading their
    // implementations.
    assert.equal(readsInWindow, 0,
      'nothing may observe the flag between the scan recording the project and the box coming back — that withheld observation IS the test');
    host.conventions = realConventions;

    // The first read of the flag in this scan's state, and it lands after
    // recovery. A probe taken now would succeed; the answer must not come from
    // one.
    const first = await host.conventions();
    assert.equal(first.project.degraded, true,
      'the first read of the flag happens after recovery and is still degraded — the catalog is missing this project\'s plugins until a scan rebuilds it, whatever the box is doing now');
    assert.equal(bodyOf(first, 'gated-plug/frag'), null,
      'and the fragment really is absent — the catalog was not quietly repaired either');

    const res = await ensureProjectConventionsMd('referencer');
    assert.equal(res.skipped, 'catalog-degraded');
    assert.equal(await fs.readFile(target, 'utf8'), doc,
      'so the committed file survives an outage nobody looked at, which is the defect this card exists to stop');
  });
});
