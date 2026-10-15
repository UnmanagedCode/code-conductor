// Editing a project's convention selection after creation (src/projectClaudeMd.ts
// `setProjectConventions`, REST `PUT /api/projects/:name/conventions`), and the
// `conventions` field `GET /api/projects` reports per row so the sidebar can
// flag a project with no selection or with a slug that no longer resolves.
//
// The edit goes through the same writer as the regeneration sweep, so a file it
// writes is exactly what a sweep would write for that marker. It keeps an
// unresolvable slug only if the file already names it, refuses a stale dialog
// (409), and holds the freeze rule: a degraded catalog never lets it write a
// marker that keeps an unresolvable slug (503).

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { createProject, projectStoreDir } from '../src/projects.ts';
import {
  addCustomConvention, deleteCustomConvention, setPluginConventionsProvider,
} from '../src/projectConventions.ts';
import {
  composeProjectConventionsDoc, ensureProjectConventionsMd, setProjectConventions,
} from '../src/projectClaudeMd.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, home, projectsRoot;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => {
  setPluginConventionsProvider(null);
  await ctx.instances.shutdown();
  disposeSystemHandles();
  await rmrf(home);
});

const conventionsPath = (name) => path.join(projectsRoot, name, 'CONVENTIONS.md');
const put = (name, body) => api(baseUrl, 'PUT', `/api/projects/${name}/conventions`, body);
const marker = async (name) => (await fs.readFile(conventionsPath(name), 'utf8')).split('\n', 1)[0];
const row = async (name) => (await api(baseUrl, 'GET', '/api/projects')).body.find(p => p.name === name);

async function projectWith(name, slugs) {
  await createProject(name, { conventionsDoc: await composeProjectConventionsDoc(slugs) });
}

// A project whose marker keeps `doomed`, a custom convention since deleted.
async function projectWithDeleted(name, others = ['design-guidelines']) {
  await addCustomConvention({ slug: 'doomed', name: 'Doomed', description: 'x', body: '## Doomed\n- rule' });
  await projectWith(name, ['doomed', ...others]);
  await deleteCustomConvention('doomed');
}

describe('PUT /api/projects/:name/conventions', () => {
  // PINS: the edit writes exactly what a sweep would for the new marker, so
  // the next sweep is a no-op, and answers the documented body.
  test('replaces the selection with the composed document', async () => {
    await projectWith('p', ['design-guidelines']);
    const r = await put('p', { slugs: ['testing-guidelines', 'documentation-guidelines'], expected: ['design-guidelines'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      ok: true, path: conventionsPath('p'),
      selected: ['testing-guidelines', 'documentation-guidelines'], unresolved: [],
    });
    const want = await composeProjectConventionsDoc(['testing-guidelines', 'documentation-guidelines']);
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), want);
    await ensureProjectConventionsMd('p');
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), want, 'a sweep afterwards changes nothing');
  });

  // PINS: a slug the catalog lacks but the marker already names is kept, in
  // request order, and the body names it as unavailable.
  test('keeps an unresolvable slug the file already names', async () => {
    await projectWithDeleted('p');
    const r = await put('p', { slugs: ['testing-guidelines', 'doomed'], expected: ['doomed', 'design-guidelines'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.selected, ['testing-guidelines', 'doomed']);
    assert.deepEqual(r.body.unresolved, ['doomed']);
    const content = await fs.readFile(conventionsPath('p'), 'utf8');
    assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions testing-guidelines,doomed -->');
    assert.match(content, /> Convention unavailable: `doomed`\./);
  });

  // PINS: an unresolvable slug can only be kept, never introduced.
  test('refuses a slug in neither the catalog nor the current marker, and writes nothing', async () => {
    await projectWith('p', ['design-guidelines']);
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    const r = await put('p', { slugs: ['design-guidelines', 'no-such-slug'], expected: ['design-guidelines'] });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /no-such-slug/);
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before);
  });

  // PINS: the lost-update guard — `expected` must equal the file's marker.
  test('refuses a stale expected with 409 and writes nothing', async () => {
    await projectWith('p', ['design-guidelines', 'testing-guidelines']);
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    const r = await put('p', { slugs: ['documentation-guidelines'], expected: ['design-guidelines'] });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /design-guidelines,testing-guidelines|design-guidelines, testing-guidelines/);
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before);
  });

  // PINS: the freeze rule holds for the edit — degraded + an unresolvable kept
  // slug is 503 CONVENTIONS_CATALOG_DEGRADED with the file byte-identical;
  // dropping that slug lets the same edit through.
  test('a degraded catalog refuses to keep an unresolvable slug, and allows dropping it', async () => {
    await projectWithDeleted('p');
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    setPluginConventionsProvider(async () => { throw new Error('transient plugin host failure'); });
    const refused = await put('p', { slugs: ['doomed', 'testing-guidelines'], expected: ['doomed', 'design-guidelines'] });
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'CONVENTIONS_CATALOG_DEGRADED');
    assert.match(refused.body.error, /doomed/);
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before, 'the file is left as it is');

    const allowed = await put('p', { slugs: ['testing-guidelines'], expected: ['doomed', 'design-guidelines'] });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(await marker('p'), '<!-- cc:conventions testing-guidelines -->');
  });

  // PINS: the edit writes through the project's System, keeping the System
  // disclosure a remote project's document carries.
  test('rewrites the file on a system project and keeps its System disclosure', async () => {
    const remote = await bindRemoteSystem();
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });
    await ensureProjectConventionsMd('app');
    const r = await put('app', { slugs: ['design-guidelines'], expected: [] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const content = await fs.readFile(path.join(tree, 'CONVENTIONS.md'), 'utf8');
    assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions design-guidelines -->');
    assert.match(content, /^# System$/m);
    assert.match(content, /## Design guidelines/);
  });

  // PINS: the request body's shape is checked before anything is read.
  test('refuses a malformed body with 400', async () => {
    await projectWith('p', []);
    for (const body of [
      { expected: [] },
      { slugs: 'design-guidelines', expected: [] },
      { slugs: ['design-guidelines'] },
      { slugs: ['design-guidelines'], expected: 'x' },
      { slugs: [1], expected: [] },
      { slugs: ['design-guidelines'], expected: [null] },
      { slugs: ['design-guidelines', 'design-guidelines'], expected: [] },
    ]) {
      const r = await put('p', body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    }
  });

  // PINS: an unknown project is 404, not a write somewhere.
  test('answers 404 for an unknown project', async () => {
    const r = await put('nope', { slugs: [], expected: [] });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
});

describe('GET /api/projects conventions field', () => {
  // PINS: an absent file reads as no selection.
  test('no CONVENTIONS.md → selected []', async () => {
    await createProject('p');
    await fs.rm(conventionsPath('p'), { force: true });
    assert.deepEqual((await row('p')).conventions, { selected: [], unresolved: [] });
  });

  // PINS: a first line that is not a marker reads as no selection.
  test('a non-marker first line → selected []', async () => {
    await createProject('p');
    await fs.writeFile(conventionsPath('p'), '# My own conventions\n');
    assert.deepEqual((await row('p')).conventions, { selected: [], unresolved: [] });
  });

  // PINS: a zero-slug marker reads as no selection.
  test('a zero-slug marker → selected []', async () => {
    await projectWith('p', []);
    assert.deepEqual((await row('p')).conventions, { selected: [], unresolved: [] });
  });

  // PINS: marker order is kept, and `unresolved` names exactly the slugs the
  // current catalog lacks.
  test('marker slugs in order, unresolved naming the deleted custom one', async () => {
    await projectWithDeleted('p', ['testing-guidelines', 'design-guidelines']);
    assert.deepEqual((await row('p')).conventions, {
      selected: ['doomed', 'testing-guidelines', 'design-guidelines'], unresolved: ['doomed'],
    });
  });

  // PINS: an unresolvable project carries no `conventions` key at all.
  test('an unreachable project has no conventions key', async () => {
    const dir = projectStoreDir('beta');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'project.json'),
      JSON.stringify({ location: { kind: 'remote', system: 'prod-box', remoteId: null, path: '/app' } }));
    const beta = await row('beta');
    assert.ok(beta.systemUnreachable, 'premise: the row is unreachable');
    assert.equal('conventions' in beta, false);
  });
});

// PINS: the edit and the sweep never interleave on one project — an edit
// started while a sweep is mid-flight lands after it, so the sweep cannot write
// the old marker back over the edit.
test('a sweep in flight cannot write the old marker back over an edit', async () => {
  await projectWith('p', ['design-guidelines']);
  const pending = [];
  setPluginConventionsProvider(() => new Promise((resolve) => { pending.push(() => resolve([])); }));
  let settled = 0;
  const sweep = ensureProjectConventionsMd('p').finally(() => { settled++; });
  // The sweep has read the old marker and is held at its catalog read.
  await waitFor(() => pending.length === 1);
  const edit = setProjectConventions('p', ['testing-guidelines'], ['design-guidelines']).finally(() => { settled++; });
  // Wait until no new provider call has arrived for a quiet window, then release
  // the newest one. Without serialization both are pending at once and the
  // edit's is released first, so it lands first and the sweep lands last.
  const quiet = async () => {
    for (let seen = -1; seen !== pending.length;) {
      seen = pending.length;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  while (settled < 2) {
    await quiet();
    if (pending.length) pending.pop()();
  }
  await Promise.all([sweep, edit]);
  assert.equal(await marker('p'), '<!-- cc:conventions testing-guidelines -->');
});
