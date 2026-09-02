// THE CONDUCTOR ROLE DOC IS COMPOSED OVER A DEGRADED CATALOG, AND THE OPERATOR
// LOG SAYS SO — card 2026-0277.
//
// `composeConduct` used to consult nothing. A plugin's conductor-scope
// conventions are derived LIVE from the catalog, so while the plugin's project
// is unreachable the slug is absent from the selection as well as from the
// catalog — `compose()` is never asked for a slug it cannot resolve, its
// unknown-slug 400 never fires, and the section simply is not there. The
// resulting document is BYTE-IDENTICAL to the one composed after the plugin is
// deliberately DISABLED (T1): cc rendered an unvouchable absence exactly as a
// confirmed one, and in the latched scan-sourced arm emitted ZERO lines saying
// so (T2).
//
// The chosen behaviour — compose anyway, warn the operator once, never touch
// the document — is stated for a reader at `composeConduct` (src/
// conductorConventions.ts). What is asserted here is that behaviour, in the
// three shapes it has to survive: the document is unchanged (T1), the operator
// hears about it exactly once in the arm where nothing spoke before (T2), and
// the healthy path pays nothing (T4).
//
// A NEW FILE rather than additions to tests/plugins-discovery-degrade.test.mjs,
// on that file's own rationale: its reds must keep naming the DISCOVERY-time
// mechanism, and a red here must name `composeConduct`'s POLICY on a degraded
// catalog. Its D1 (`conductor.degraded === true`) is the upstream of this whole
// file and is a guard test for it — green before, green after, unedited.
//
// The fixture is tests/fixtures/gatedProvider.mjs, the same real provider those
// files use: a box that is simply down, with cc's registry row, project record
// and live handle all untouched. Nothing is shimmed or injected — a real
// provider going down is the production path. T1 spawns a REAL conductor
// through `POST /api/instances` during the outage rather than reasoning about a
// proxy for one.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor as waitForHelper, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { waitFor } from './plugin-helpers.mjs';
import { createPluginHost } from '../src/plugins/registry.ts';
import { createProject, projectsRoot, orchStoreRoot, tryResolveProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { setPluginConventionsProvider } from '../src/projectConventions.ts';
import {
  SEED_CONVENTIONS, setPluginConductorConventionsProvider, setSelection, getSelection,
  composeCurrentConduct,
} from '../src/conductorConventions.ts';
import { composeProjectConventionsDoc, ensureProjectConventionsMd, conventionsTargetPath } from '../src/projectClaudeMd.ts';
import { conductConventionsPath, materializeCurrentConduct } from '../src/conduct.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATED = path.join(__dirname, 'fixtures', 'gatedProvider.mjs');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const FRAGMENT_REL = path.join('conventions', 'sample.md');
const MARK = '## Gated conductor convention';
const SEEDS = SEED_CONVENTIONS.map(m => m.slug);
const PLAYBOOKS_SLUG = 'playbooks';

// A plugin whose conventions span BOTH scopes — the conductor one is what the
// role doc loses, the project one is what gives ensureProjectConventionsMd's
// freeze a `missing` set to key on (T3). One manifest, so both policies are
// observed under ONE outage.
function bothScopes(id) {
  return {
    id, name: id, version: '1.0.0', pluginApi: 1,
    conventions: [
      { slug: 'cfrag', name: 'CFrag', description: 'x', file: 'conventions/sample.md', scope: 'conductor' },
      { slug: 'pfrag', name: 'PFrag', description: 'x', file: 'conventions/sample.md', scope: 'project' },
    ],
  };
}

// A plugin declaring PROJECT scope only — the no-loss arm (T5). The conductor
// scope array is still flagged degraded (the flag fans out to every scope) while
// the role doc loses nothing at all.
function projectScopeOnly(id) {
  return {
    id, name: id, version: '1.0.0', pluginApi: 1,
    conventions: [{ slug: 'pfrag', name: 'PFrag', description: 'x', file: 'conventions/sample.md', scope: 'project' }],
  };
}

async function seedPluginTree(dir, m) {
  await fs.mkdir(path.join(dir, 'conventions'), { recursive: true });
  await fs.writeFile(path.join(dir, FRAGMENT_REL), `${MARK}\n- gated body\n`);
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(m, null, 2));
  return dir;
}

// console.warn lines emitted while `fn` runs, censused by the prefix before the
// first ':' — the shape the plan's measurement used, and the shape that lets an
// assertion say "exactly one line from conductorConventions and nothing else"
// without pinning any wording beyond the two tokens T2 names.
async function withWarns(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  try { return { value: await fn(), lines }; }
  finally { console.warn = orig; }
}

const census = (lines) => {
  const out = {};
  for (const l of lines) {
    const k = l.includes(':') ? l.slice(0, l.indexOf(':')) : l;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

describe('the conductor role doc composed over a degraded convention catalog', () => {
  let ctx, baseUrl, instances;
  let home, host, gate, boxRoot, boxSys, scans;

  before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
  after(async () => { await ctx.close(); });

  // Both provider seams point at THIS test's host (server.ts wires the booted
  // server's own host to the same two setters; overriding them is how every
  // plugin-conventions test drives a host of its own). Every conventions() call
  // either seam makes is counted here — that is the "placement scan per
  // conductor launch" number T4 pins.
  const countedConventions = async () => { scans++; return host.conventions(); };
  function wire() {
    setPluginConductorConventionsProvider(async () => (await countedConventions()).conductor);
    setPluginConventionsProvider(async () => (await countedConventions()).project);
  }

  // The box is down for cc only while the gate file exists; dropping the live
  // handle is what makes the next connection re-read it. Verbatim in shape from
  // plugins-discovery-degrade.test.mjs, including why the reachable-again probe
  // has to be a measurement rather than an elapsed wait: the failed connection
  // is cached with its failure count and refuses inside its own retry window
  // without contacting the provider, so an assertion taken in that window
  // cannot tell "latched" from "refused by a backoff".
  async function boxDown() {
    await fs.writeFile(gate, '');
    disposeSystemHandles();
  }
  async function boxVerifiablyReachable(project, manifestPath) {
    await fs.rm(gate);
    disposeSystemHandles();
    await waitFor(async () => {
      const { system } = await tryResolveProject(project);
      if (!system) return false;
      return (await system.readFile(manifestPath)).includes('"id"');
    }, { timeout: 15000, interval: 25 });
  }

  async function boxProject(name) {
    const tree = path.join(boxRoot, name);
    await createProject(name, { system: boxSys.id, remoteId: 'g', systemPath: tree });
    return tree;
  }

  // A local project whose committed CONVENTIONS.md carries `slugs`, plus the
  // exact bytes it was written with — the thing a rewrite would change.
  async function referencer(name, slugs) {
    const doc = await composeProjectConventionsDoc(slugs);
    await createProject(name, { conventionsDoc: doc });
    const target = conventionsTargetPath(path.join(projectsRoot(), name));
    assert.equal(await fs.readFile(target, 'utf8'), doc, 'the referencing file starts out as composed');
    return { doc, target };
  }

  // A real conductor spawn: the .conduct project ensured, POST /api/instances,
  // waited to idle, and the role doc read back off disk afterwards.
  async function spawnConductor() {
    await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: '.conduct', model: 'claude-haiku-4-5', temp: true, mode: 'bypassPermissions',
    });
    assert.equal(r.status, 201, 'the spawn is not refused');
    await waitForHelper(() => instances.get(r.body.id)?.status === 'idle');
    return { id: r.body.id, doc: await fs.readFile(conductConventionsPath(), 'utf8') };
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
    scans = 0;
    wire();
  });
  afterEach(async () => {
    setPluginConductorConventionsProvider(null);
    setPluginConventionsProvider(null);
    await host.stopAll();
    await instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
    await rmrf(boxRoot);
  });

  // T1 ─────────────────────────────────────────────────────────────────
  // PINS: the chosen behaviour for a conductor spawned during the outage,
  // stated as an EQUALITY. A real `POST /api/instances` still returns 201 and
  // reaches idle, the role doc is still written, the unreachable plugin's
  // conductor section is absent from it, and the document is BYTE-IDENTICAL to
  // the one composed with that plugin deliberately DISABLED. Recovery needs no
  // gesture on this (compose-sourced) path: the next spawn's doc is
  // byte-identical to the healthy one.
  //
  // NOT CLAIMING: that a conductor SESSION behaves differently for lacking the
  // text (untestable, and the reason the fix adds nothing to the document);
  // that the latched scan-sourced source recovers the same way (it does not —
  // it needs a Rescan, which is T2's arm); that 201 means the composed doc is
  // CORRECT, only that the spawn is not refused; that the plugin's project is
  // reachable during the disabled arm's compose (it is — the arm exists to
  // produce a confirmed absence, not another unvouchable one).
  test('a conductor spawned during the outage still launches, and its role doc equals the confirmed-absence doc', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');
    assert.ok((await getSelection()).includes('gated-plug/cfrag'), 'the plugin convention is on by default');

    const healthy = await spawnConductor();
    assert.ok(healthy.doc.includes(MARK), 'the healthy role doc carries the plugin section');

    // NO RESCAN — the compose-time degrade alone reproduces this, which is what
    // makes the defect pre-existing rather than a regression from card 2026-0272.
    await boxDown();
    const degraded = await spawnConductor();
    assert.ok(!degraded.doc.includes(MARK), 'the section is gone from the doc a conductor was launched with');
    assert.ok(degraded.doc.length < healthy.doc.length, 'and the doc is shorter for it');

    await boxVerifiablyReachable('gp', path.join(tree, 'conductor.plugin.json'));
    const recovered = await spawnConductor();
    assert.equal(recovered.doc, healthy.doc, 'the next spawn after recovery is byte-identical to the healthy doc');

    // The equality this card is about: an UNVOUCHABLE absence renders exactly
    // as a CONFIRMED one. Kills any mutant that marks the document — a banner,
    // a comment, a marker, a blank line.
    await host.disable('gated-plug');
    const disabled = await spawnConductor();
    assert.equal(degraded.doc, disabled.doc,
      'the degraded doc is byte-identical to the doc composed with the plugin disabled');
  });

  // T2 ─────────────────────────────────────────────────────────────────
  // PINS: the operator signal, in the arm where NOTHING spoke before. A rescan
  // taken with the box down latches the degrade into the discovery catalog, and
  // no placement resolution is attempted at compose time — so before this card
  // that compose emitted zero warn lines of any kind. Exactly ONE line now
  // fires, from `conductorConventions`, naming both the degradation and the
  // ROLE DOC, and nothing else is logged.
  //
  // The selection deliberately has the `playbooks` convention REMOVED: the read
  // must sit above the generated-sections branch that rides that slug, or the
  // signal vanishes for every session with playbooks off.
  //
  // NOT CLAIMING: that the line names which slug or which plugin is missing (it
  // cannot — no persisted record of the conductor scope's plugin selection
  // exists; T6); that it prescribes a remedy (deliberately none — the two
  // degrade sources clear differently and the flag carries no cause); that
  // stdout is checked; that the wording beyond those two tokens is pinned.
  test('a latched scan-sourced degrade warns exactly once, naming the role doc — the arm that was silent', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');
    await setSelection([...SEEDS.filter(s => s !== PLAYBOOKS_SLUG), 'gated-plug/cfrag']);

    await boxDown();
    await host.rescan();
    assert.equal((await host.conventions()).conductor.degraded, true, 'the latched scan degraded the conductor scope');

    const { value: doc, lines } = await withWarns(() => composeCurrentConduct());
    assert.ok(!doc.includes(MARK), 'the composed doc is missing the section');
    assert.deepEqual(census(lines), { conductorConventions: 1 },
      'exactly one line, from conductorConventions, and nothing else on this path');
    assert.match(lines[0], /degraded/i, 'the line says the catalog was degraded');
    assert.match(lines[0], /role doc/i, 'and attributes it to the role doc — the attribution nothing carried');
  });

  // T3 ─────────────────────────────────────────────────────────────────
  // PINS: criterion 4 as OBSERVABLE BEHAVIOUR rather than prose — the two
  // policies for the same flag, on one fixture, under one outage. The project
  // scope DECLINES to write (its committed file stays byte-identical, keyed on
  // the `missing` set its line-1 marker yields), while the conductor scope's
  // sole writer OVERWRITES `.conduct/CONVENTIONS.md` with the incomplete doc.
  //
  // NOT CLAIMING: that the difference is DESIRABLE for the role doc, only that
  // it is the chosen and documented one; that `.conduct/CONVENTIONS.md` is
  // committed anywhere (it is not — and the freeze never depended on that, it
  // is a decline-to-write over whatever is on disk); that the conductor scope
  // could not gain a marker analogue.
  test('one outage, two policies: the project file freezes while the role doc is overwritten', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');
    const { doc: committed, target } = await referencer('referencer', ['gated-plug/pfrag', 'design-guidelines']);

    await materializeCurrentConduct();
    const before = await fs.readFile(conductConventionsPath(), 'utf8');
    assert.ok(before.includes(MARK), 'the role doc on disk is complete before the outage');

    await boxDown();

    const res = await ensureProjectConventionsMd('referencer');
    assert.equal(res.skipped, 'catalog-degraded', 'the project scope declines to write');
    assert.deepEqual(res.missing, ['gated-plug/pfrag']);
    assert.equal(await fs.readFile(target, 'utf8'), committed, 'the committed project file is byte-identical');

    await materializeCurrentConduct();
    const after = await fs.readFile(conductConventionsPath(), 'utf8');
    assert.ok(!after.includes(MARK), 'while the role doc is overwritten without the section');
    assert.notEqual(after, before, 'the complete doc that was on disk did not survive');
  });

  // T4 ─────────────────────────────────────────────────────────────────
  // PINS: the NO-CHANGE CONTROL for the healthy path, COUNTED rather than
  // argued. A healthy conductor launch composes the plugin section, logs
  // nothing, and performs exactly TWO plugin placement scans — one for the
  // selection's derive, one for the compose — because the degraded flag rides
  // the `getCatalog()` call compose already makes.
  //
  // NOT CLAIMING: that 2 is a contract for all time — it is the count as
  // measured on this branch, pinned so a stray extra read (e.g. reaching for a
  // second getCatalog() to fetch the flag) cannot land unnoticed; that no
  // OTHER subsystem may log during a launch (only these two seams' prefixes are
  // censused); that the scan is cheap.
  test('a healthy conductor launch: section present, zero warn lines, exactly 2 placement scans', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');
    await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');

    scans = 0;
    const { value: spawned, lines } = await withWarns(() => spawnConductor());
    assert.ok(spawned.doc.includes(MARK), 'the healthy doc carries the section');
    assert.equal(scans, 2, 'one placement scan for the selection derive, one for the compose');
    assert.deepEqual(census(lines.filter(l => /^(conductorConventions|plugins|fragmentCatalog):/.test(l))), {},
      'a healthy catalog costs the operator no line');
  });

  // T5 ─────────────────────────────────────────────────────────────────
  // PINS: the NO-LOSS arm, which is why the warn's `may` is load-bearing. An
  // unreachable plugin declaring ONLY project-scope conventions still flags the
  // conductor scope degraded (the flag fans out to every scope and carries no
  // cause), the role doc is BYTE-IDENTICAL to the healthy one, and the warn
  // still fires. So the line must not assert that anything IS missing.
  //
  // NOT CLAIMING: that over-warning is desirable; that a narrowing term could
  // never exist in some future store, only that none exists today — the flag
  // cannot see whether the conductor scope had an entry to lose.
  test('the no-loss arm: degraded with nothing lost, doc byte-identical, and the warn still fires', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, projectScopeOnly('gated-plug'));
    await host.enable('gated-plug');

    const healthyDoc = await composeCurrentConduct();
    assert.ok(!healthyDoc.includes(MARK), 'the plugin contributes nothing to the conductor scope even when healthy');

    await boxDown();
    assert.equal((await host.conventions()).conductor.degraded, true,
      'the conductor scope is flagged although it had no entry to lose');

    const { value: doc, lines } = await withWarns(() => composeCurrentConduct());
    assert.equal(doc, healthyDoc, 'the role doc is byte-identical to the healthy one — nothing was lost');
    assert.equal(census(lines).conductorConventions, 1,
      'and the warn fires anyway, so its wording must stay a `may`');
  });

  // T6 ─────────────────────────────────────────────────────────────────
  // PINS: the measured basis of the amended criterion 4 — there is NO marker
  // analogue to key a freeze on. After an explicit Save with the plugin's
  // conductor convention checked, the store holds no plugin slug anywhere: not
  // in `enabled` (plugin slugs never persist there) and not in `pluginOff`
  // (that records only explicit OFF-switches). So nothing survives the outage
  // to say what the selection was SUPPOSED to contain, and no `missing` set can
  // be computed.
  //
  // NOT CLAIMING: that such a record could not be added; that its absence is a
  // defect — it is the design that makes a disabled plugin's conventions vanish
  // with no purge step.
  test('an explicit Save with the plugin convention on persists no plugin slug — no missing set to freeze on', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');

    await setSelection([...SEEDS, 'gated-plug/cfrag']);
    assert.ok((await getSelection()).includes('gated-plug/cfrag'), 'the convention is enabled after the Save');

    const store = JSON.parse(await fs.readFile(path.join(orchStoreRoot(), 'conventions', 'conductor.json'), 'utf8'));
    assert.deepEqual(store.enabled, SEEDS, 'enabled holds the seed slugs only');
    assert.deepEqual(store.pluginOff, [], 'and pluginOff is empty — an ON plugin convention leaves no trace');
  });
});
