// THE CONVENTIONS LISTINGS SAY THEY MAY BE SHORT, AND A PROJECT CREATED FROM A
// SHORT ONE IS DURABLE — card 2026-0282.
//
// `list_project_conventions` / `list_conductor_conventions` used to return
// `catalog.map(…)`. `Array.prototype.map` does not carry an array's own
// property, and neither does the `JSON.stringify` the `tools/call` dispatcher
// applies to a non-text result (src/mcp/server.ts) — so the `CatalogList`'s
// `degraded` flag was dropped twice over and a conductor read a list missing an
// unreachable plugin's conventions exactly as it reads a complete one.
//
// The project scope is the worse half, because its consequence is COMMITTED:
// `conventions/conductor/core.md` tells a conductor to feed the listing into
// `create_project`, and the project it creates carries a line-1
// `<!-- cc:conventions … -->` marker that never named the unreachable plugin's
// slug. No later regeneration adds it back, and the `projectClaudeMd` freeze
// can never protect that project — the freeze is keyed on unresolvable slugs IN
// THAT MARKER, and the marker has none (T3). The one-time `scaffold` directive
// is lost the same way, and nothing ever reissues it.
//
// A NEW FILE rather than additions to tests/conductor-role-doc-degrade.test.mjs,
// on that file's own rationale: its reds must keep naming `composeConduct`'s
// policy, and a red here must name the conventions LISTING and the project
// CREATED from it.
//
// The fixture is tests/fixtures/gatedProvider.mjs, the same real provider the
// other degrade files use: a box that is simply down, with cc's registry row,
// project record and live handle all untouched. Nothing is shimmed — a real
// provider going down is the production path. The plugin declares TWO
// project-scope conventions (one fragment-bearing, one scaffold-only) because
// the scaffold pin needs the second one and because a warn emitted per dropped
// ENTRY rather than per creation would then be visible as two lines (T4).

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { waitFor } from './plugin-helpers.mjs';
import { createPluginHost } from '../src/plugins/registry.ts';
import { createProject, projectsRoot, tryResolveProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { setPluginConventionsProvider } from '../src/projectConventions.ts';
import { setPluginConductorConventionsProvider } from '../src/conductorConventions.ts';
import {
  composeProjectConventionsDoc, ensureProjectConventionsMd, conventionsTargetPath,
  regenerateAllProjectConventions,
} from '../src/projectClaudeMd.ts';
import { listProjectConventions, listConductorConventions, createProject as mcpCreateProject } from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATED = path.join(__dirname, 'fixtures', 'gatedProvider.mjs');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const FRAGMENT_REL = path.join('conventions', 'sample.md');
const MARK = '## Gated project convention';
const SCAFFOLD_TEXT = 'Wire up the gated harness before other work';

// A plugin declaring TWO PROJECT-scope conventions plus one conductor-scope
// one. `pfrag` carries a fragment, `sfrag` carries only a scaffold facet — the
// second durable loss this card measures. `cfrag` is what gives the conductor
// scope something of its own to lose under the same outage.
function bothScopes(id) {
  return {
    id, name: id, version: '1.0.0', pluginApi: 1,
    conventions: [
      { slug: 'cfrag', name: 'CFrag', description: 'x', file: FRAGMENT_REL, scope: 'conductor' },
      { slug: 'pfrag', name: 'PFrag', description: 'x', file: FRAGMENT_REL, scope: 'project' },
      { slug: 'sfrag', name: 'SFrag', description: 'x', scaffold: { text: SCAFFOLD_TEXT }, scope: 'project' },
    ],
  };
}

// A plugin declaring CONDUCTOR scope only — the no-loss arm for the PROJECT
// listing (T5). The project scope is still flagged degraded (the flag fans out
// to every scope and carries no cause) while the project catalog loses nothing.
function conductorScopeOnly(id) {
  return {
    id, name: id, version: '1.0.0', pluginApi: 1,
    conventions: [{ slug: 'cfrag', name: 'CFrag', description: 'x', file: FRAGMENT_REL, scope: 'conductor' }],
  };
}

async function seedPluginTree(dir, m) {
  await fs.mkdir(path.join(dir, 'conventions'), { recursive: true });
  await fs.writeFile(path.join(dir, FRAGMENT_REL), `${MARK}\n- gated body\n`);
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(m, null, 2));
  return dir;
}

// console.warn lines emitted while `fn` runs, plus a census keyed by the prefix
// before the first ':' (every warn on this path is module-prefixed). Counting by
// prefix is what lets an assertion say "exactly one line from createProject and
// nothing else" without pinning any wording. Verbatim in shape from
// tests/conductor-role-doc-degrade.test.mjs.
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

const line1 = async (name) => (await fs.readFile(conventionsTargetPath(path.join(projectsRoot(), name)), 'utf8')).split('\n', 1)[0];

describe('the conventions listings and the project created from them, over a degraded catalog', () => {
  let ctx, baseUrl, instances;
  let home, host, gate, boxRoot, boxSys, reads;

  before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
  after(async () => { await ctx.close(); });

  // Both provider seams point at THIS test's host (server.ts wires the booted
  // server's own host to the same two setters; overriding them is how every
  // plugin-conventions test drives a host of its own — and it is also what makes
  // the REAL `tools/call` dispatch below observe this fixture). Only the PROJECT
  // seam is counted: `reads` is the project-catalog read count T6 pins.
  function wire() {
    setPluginConductorConventionsProvider(async () => (await host.conventions()).conductor);
    setPluginConventionsProvider(async () => { reads++; return (await host.conventions()).project; });
  }

  // The box is down for cc only while the gate file exists; dropping the live
  // handle is what makes the next connection re-read it. Verbatim in shape from
  // tests/conductor-role-doc-degrade.test.mjs, including why the
  // reachable-again probe has to be a MEASUREMENT rather than an elapsed wait:
  // the failed connection is cached with its failure count and refuses inside
  // its own retry window without contacting the provider, so an assertion taken
  // in that window cannot tell "latched" from "refused by a backoff".
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

  // The LATCHED SCAN-SOURCED arm: a rescan taken with the box down seeds the
  // flag from `discoveryDegraded()` and performs no placement resolution at
  // all, so it is the arm that emitted ZERO lines of any kind before this card
  // — and it does not lift when the box comes back.
  async function latch() {
    await boxDown();
    await host.rescan();
    assert.equal((await host.conventions()).project.degraded, true, 'the latched scan degraded the project scope');
  }

  // A real `tools/call` over POST /mcp — the boundary the flag has to survive,
  // because the dispatcher renders a non-text result as JSON.stringify(result),
  // which drops an array's own property exactly as `.map()` does.
  let nextRpcId = 1;
  async function callTool(name) {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: {} } }),
    });
    const body = await res.json();
    assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.result.content), 'the tool result has content[]');
    return JSON.parse(body.result.content[0].text);
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
    reads = 0;
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
  // PINS: `list_project_conventions` carries the incompleteness THROUGH THE
  // REAL `tools/call` DISPATCH, in the latched scan-sourced arm — the one arm
  // that is silent on every other channel today. The dispatch boundary is the
  // point of the test, not the handler: the serializer there is the second half
  // of the defect's own mechanism, and a unit test on the handler's return value
  // does not cover its call site.
  //
  // NOT CLAIMING: which slug or which plugin is missing (the result cannot say
  // — the catalog's extraProvider is opaque and never reports what failed);
  // that a conductor ACTS on the field (untestable here); that the wording is
  // pinned beyond the one `marker` token, which is the durable consequence this
  // surface's reader cannot learn anywhere else.
  test('list_project_conventions carries `incomplete` through tools/call in the latched arm', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');

    const healthy = await callTool('list_project_conventions');
    assert.ok(healthy.conventions.some(c => c.slug === 'gated-plug/pfrag'), 'the healthy list carries the plugin convention');
    assert.equal('incomplete' in healthy, false, 'and says nothing about incompleteness');

    await latch();

    const degraded = await callTool('list_project_conventions');
    assert.ok(!degraded.conventions.some(c => c.slug.startsWith('gated-plug/')), 'the plugin conventions are gone from the list');
    assert.ok(degraded.conventions.length < healthy.conventions.length, 'and the list is shorter for it');
    // The claim: the SHORT list says so, on the wire, after JSON.stringify.
    assert.equal(typeof degraded.incomplete, 'string', 'the short list carries the field the array shape could not');
    assert.match(degraded.incomplete, /marker/i, 'and names the durable consequence — the committed line-1 marker');
  });

  // T2 ─────────────────────────────────────────────────────────────────
  // PINS: ONE SENTENCE PER SURFACE — the two listings' fields are
  // distinguishable and neither is a shared constant. Under one outage both
  // scopes are flagged (the flag fans out), and each field must name its OWN
  // surface's consequence: the project one a committed marker, the conductor one
  // the recomposed-every-spawn role doc that commits nothing.
  //
  // NOT CLAIMING: that either wording is fixed beyond its one token; that the
  // conductor-scope flag has a tool-reachable remedy (it does not — no tool in
  // the belt rescans); that the two surfaces degrade for separable causes (they
  // cannot — one flag, no cause).
  test('the two listings carry different sentences, each true only of its own surface', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');
    await latch();

    const proj = await listProjectConventions();
    const cond = await listConductorConventions();
    assert.match(proj.incomplete, /marker/i, 'the project surface names the committed marker');
    assert.match(cond.incomplete, /spawn/i, 'the conductor surface names the per-spawn recomposition instead');
    assert.notEqual(proj.incomplete, cond.incomplete, 'and the two are not one shared string');
  });

  // T3 ─────────────────────────────────────────────────────────────────
  // PINS: the DURABLE consequence, end to end. A create during the outage is
  // not refused; the project's line-1 marker omits the unreachable plugin's
  // slug; no `scaffold` field is emitted at all (the scaffold-only convention
  // dropped out of the list too, so the one-time setup directive is never
  // issued); and the `projectClaudeMd` freeze can NEVER protect that project —
  // it is keyed on unresolvable slugs in that marker, the marker has none, so
  // `ensureProjectConventionsMd` writes after recovery AND under a second
  // outage, leaving the marker byte-identical both times.
  //
  // NOT CLAIMING: that this behaviour is DESIRABLE, only that it is the chosen
  // and documented one; that the marker could not be made to record the slug in
  // some future design (the slug is unknowable in this arm — `storeOnlyRow`
  // carries `manifest: null` — and unreachable from the create site in every
  // arm); that a conductor would have picked the plugin slug had it seen one.
  test('a project created during the outage: short marker, no scaffold, and a freeze that can never protect it', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');

    // Healthy: the conductor's own route — read the list, create from it.
    const healthyList = await listProjectConventions();
    const healthySlugs = healthyList.conventions.map(c => c.slug);
    assert.ok(healthySlugs.includes('gated-plug/sfrag'), 'the scaffold-only convention is in the healthy list');
    const healthyCreate = await mcpCreateProject({ name: 'goodproj', conventions: healthySlugs });
    assert.ok(healthyCreate.scaffold?.includes(SCAFFOLD_TEXT), 'the healthy create emits the one-time directive');

    await latch();

    const shortList = await listProjectConventions();
    const shortSlugs = shortList.conventions.map(c => c.slug);
    assert.ok(!shortSlugs.some(s => s.startsWith('gated-plug/')), 'neither plugin convention is offered');

    const made = await mcpCreateProject({ name: 'newproj', conventions: shortSlugs });
    assert.equal(made.name, 'newproj', 'the create is not refused');
    assert.equal(made.scaffold, undefined, 'and emits NO scaffold field — the directive is never issued');

    const marker = await line1('newproj');
    assert.ok(!marker.includes('gated-plug/'), 'the committed marker never named the unreachable plugin');

    // The freeze is keyed on `missing` — marker slugs that do not resolve. This
    // marker has none, so there is nothing for the freeze to key on, ever.
    await boxVerifiablyReachable('gp', path.join(tree, 'conductor.plugin.json'));
    const after = await ensureProjectConventionsMd('newproj');
    assert.equal(after.regenerated, true, 'regeneration WRITES rather than declining');
    assert.deepEqual(after.missing, [], 'because the marker offers it no unresolvable slug');
    assert.equal(await line1('newproj'), marker, 'and the marker is byte-identical — the slug is not added back');

    await latch();
    const again = await ensureProjectConventionsMd('newproj');
    assert.equal(again.regenerated, true, 'and it writes under a SECOND outage too');
    assert.equal(await line1('newproj'), marker, 'still byte-identical');
  });

  // T4 ─────────────────────────────────────────────────────────────────
  // PINS: the OPERATOR signal — exactly ONE line per creation, naming the
  // project, in the latched arm that was silent. The fixture declares TWO
  // project-scope conventions, which is load-bearing: a warn emitted per
  // DROPPED ENTRY rather than per creation would show up here as two lines.
  //
  // NOT CLAIMING: that the line names the slug or a remedy (deliberately
  // neither — the slug is unreachable from the create site and the two degrade
  // sources clear differently); that stdout is checked; that the wording is
  // pinned beyond the `degraded` token and the project name.
  test('one createProject warn per creation, naming the project, and nothing else speaks', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');
    await latch();

    const { lines } = await withWarns(() => mcpCreateProject({ name: 'warned', conventions: ['design-guidelines'] }));
    assert.deepEqual(census(lines), { createProject: 1 },
      'exactly one line, from createProject, and nothing else on this path');
    assert.match(lines[0], /degraded/i, 'the line says the catalog was degraded');
    assert.ok(lines[0].includes("'warned'"), 'and names the project — the only identifier available here');
  });

  // T4b ────────────────────────────────────────────────────────────────
  // PINS: the warn is about a project that EXISTS. Every clause in it is a
  // possessive claim about artifacts a create produces — "ITS CONVENTIONS.md
  // marker", "ITS scaffold directive" — so a create that fails after the
  // composition must emit nothing, or the operator is sent looking for a marker
  // that was never written. Both refusal shapes reachable during a degrade are
  // checked: the 409 duplicate, which fails at `fsCreateProject` AFTER the
  // document is composed, and the unknown-slug 400, which throws inside the
  // composition upstream of any warn.
  //
  // NOT CLAIMING: that these are the only ways a create can fail (a system
  // outage on a remote placement is another, and it fails at the same step as
  // the 409); that a failed create should log something else instead; that the
  // successful arm's count is re-pinned here — T4 owns that.
  test('a create that FAILS during the degrade emits no createProject line at all', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');
    await latch();

    await mcpCreateProject({ name: 'taken', conventions: ['design-guidelines'] });

    const dup = await withWarns(async () => {
      await assert.rejects(
        () => mcpCreateProject({ name: 'taken', conventions: ['design-guidelines'] }),
        /already exists/,
        'the second create is refused',
      );
    });
    assert.equal(census(dup.lines).createProject, undefined,
      'a refused create writes no marker, so it must claim nothing about one');

    const unknown = await withWarns(async () => {
      await assert.rejects(
        () => mcpCreateProject({ name: 'never', conventions: ['no-such-slug'] }),
        /unknown convention slug/,
        'an unknown slug is refused',
      );
    });
    assert.equal(census(unknown.lines).createProject, undefined,
      'and neither does one refused before the composition finishes');
  });

  // T5 ─────────────────────────────────────────────────────────────────
  // PINS: the NO-LOSS arm, which is why every sentence stays a `may`. An
  // unreachable plugin declaring ONLY conductor-scope conventions still flags
  // the PROJECT catalog degraded (the flag fans out to every scope and carries
  // no cause), the project listing returns the same slugs as healthy, and both
  // the `incomplete` field and the create warn fire anyway.
  //
  // NOT CLAIMING: that over-warning is desirable; that a narrowing term could
  // never exist in some future store — only that none is available at this site
  // today: the create path and the two listings have no access to which scopes
  // the failed plugin declared.
  test('the no-loss arm: same slugs as healthy, `incomplete` still present, warn still fires', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, conductorScopeOnly('gated-plug'));
    await host.enable('gated-plug');

    const healthySlugs = (await listProjectConventions()).conventions.map(c => c.slug);
    await latch();

    const short = await listProjectConventions();
    assert.deepEqual(short.conventions.map(c => c.slug), healthySlugs,
      'the project listing lost nothing — the plugin declared no project convention');
    assert.equal(typeof short.incomplete, 'string', 'and it is flagged anyway, so the sentence must stay a `may`');

    const { lines } = await withWarns(() => mcpCreateProject({ name: 'noloss', conventions: healthySlugs }));
    assert.equal(census(lines).createProject, 1, 'and the create warn fires anyway');
  });

  // T6 ─────────────────────────────────────────────────────────────────
  // PINS: the HEALTHY NO-CHANGE CONTROL, counted rather than argued. Neither
  // listing carries an `incomplete` key, a create logs nothing, and a create
  // performs exactly TWO project-catalog reads — one for the document, one for
  // the scaffold — because the flag rides the read `compose` already makes. One
  // read with an empty selection, where the scaffold composition returns before
  // reading at all.
  //
  // NOT CLAIMING: that 2 and 1 are contracts for all time — they are the counts
  // measured on this branch, pinned so a stray read (e.g. reaching for a second
  // getCatalog() to fetch the flag) cannot land unnoticed; that no OTHER
  // subsystem may log during a create — the census is filtered to the three
  // prefixes that can speak on this path, all of which are reachable here.
  test('a healthy create: no `incomplete` on either listing, zero warn lines, exactly 2 catalog reads', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');

    const proj = await listProjectConventions();
    const cond = await listConductorConventions();
    assert.deepEqual(Object.keys(proj), ['conventions'], 'the project listing carries no incomplete key');
    assert.deepEqual(Object.keys(cond), ['conventions'], 'nor the conductor one');

    reads = 0;
    const { lines } = await withWarns(() => mcpCreateProject({ name: 'healthy1', conventions: ['design-guidelines'] }));
    assert.equal(reads, 2, 'one project-catalog read for the document, one for the scaffold');
    assert.deepEqual(census(lines.filter(l => /^(createProject|plugins|fragmentCatalog):/.test(l))), {},
      'a healthy catalog costs the operator no line');

    reads = 0;
    await mcpCreateProject({ name: 'healthy2', conventions: [] });
    assert.equal(reads, 1, 'and an empty selection reads once — the scaffold composition returns before reading');
  });

  // T7 ─────────────────────────────────────────────────────────────────
  // PINS: the warn is CREATE-ONLY, not once per project per sweep. With the
  // catalog degraded and five projects whose markers name no plugin slug, the
  // regeneration fan-out reaches the same composition five times and every one
  // of those composes byte-identically to its healthy output — so a warn placed
  // at `composeProjectConventionsDoc` (or at its WithMeta twin) would be N false
  // positives per boot and per each convention-mutation route that fans out.
  //
  // NOT CLAIMING: that the sweep should warn some other way; that a project
  // whose marker DOES name an unresolvable slug regenerates — it freezes, which
  // is the existing contract other files pin and this fix does not touch.
  test('the regeneration sweep emits no createProject line and regenerates byte-identically', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');

    const names = ['plain0', 'plain1', 'plain2', 'plain3', 'plain4'];
    const healthy = {};
    for (const n of names) {
      const doc = await composeProjectConventionsDoc(['design-guidelines']);
      await createProject(n, { conventionsDoc: doc });
      healthy[n] = doc;
    }

    await latch();

    const { value: results, lines } = await withWarns(() => regenerateAllProjectConventions());
    const reached = results.filter(r => r.regenerated === true).map(r => r.name).sort();
    assert.deepEqual(reached.filter(n => names.includes(n)), names,
      'every one of the five reaches the composition — none is frozen');
    assert.equal(census(lines).createProject, undefined, 'and not one createProject line is emitted');
    for (const n of names) {
      assert.equal(await fs.readFile(conventionsTargetPath(path.join(projectsRoot(), n)), 'utf8'), healthy[n],
        `${n} regenerates byte-identically to its healthy output`);
    }
  });

  // T8 ─────────────────────────────────────────────────────────────────
  // PINS: ONE implementation across both create surfaces — the `POST
  // /api/projects` → `handlers.createProject` delegation is behaviour-
  // preserving. Under the same outage the route still answers 201, its RESPONSE
  // BODY is identical to the MCP handler's return for the same inputs (modulo
  // the project name, which is the only input that differs), the marker bytes
  // match, no `scaffold` field is emitted, and exactly ONE createProject warn
  // line fires — a call-site deletion that re-implemented the sequence without
  // the warn is what only this test can see.
  //
  // NOT CLAIMING: that `GET /api/settings/conventions/project` carries the flag
  // — it deliberately does not, and the comments at that route and at
  // public/newProjectDialog.js say so; that the new-project dialog shows
  // anything; that the route's own name refusals moved (they stay first, and
  // other files pin them).
  test('POST /api/projects delegates: same 201 body, same marker, no scaffold, one warn', async () => {
    const tree = await boxProject('gp');
    await seedPluginTree(tree, bothScopes('gated-plug'));
    await host.enable('gated-plug');
    await latch();

    const slugs = (await listProjectConventions()).conventions.map(c => c.slug);
    const viaHandler = await mcpCreateProject({ name: 'viahandler', conventions: slugs });

    const { value: r, lines } = await withWarns(() => api(baseUrl, 'POST', '/api/projects', { name: 'viaroute', conventions: slugs }));
    assert.equal(r.status, 201, 'the web create is not refused either');
    assert.equal(census(lines).createProject, 1, 'and it emits exactly one createProject line, like the handler');

    // The body, not just the marker: anything the route used to contribute to
    // its 201 beyond the handler's return would show up as a key or value here.
    const norm = (o, n) => JSON.stringify(o).replaceAll(n, 'NAME');
    assert.equal(norm(r.body, 'viaroute'), norm(viaHandler, 'viahandler'),
      'the 201 body is the handler\'s return verbatim');
    assert.equal(r.body.scaffold, undefined, 'no scaffold field on either surface');
    assert.equal(await line1('viaroute'), await line1('viahandler'), 'and the two markers are byte-identical');
  });
});
