// Editing a project's convention selection after creation (src/projectClaudeMd.ts
// `setProjectConventions`, REST `PUT /api/projects/:name/conventions`), and the
// `conventions` field `GET /api/projects` reports per row so the sidebar can
// flag a project whose selection is unset or names a slug that no longer
// resolves. The selection is tri-state: unset, none (chosen deliberately) and
// selected.
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
const selected = (...slugs) => ({ mode: 'selected', slugs });
const UNSET = { mode: 'unset' };
const NONE = { mode: 'none' };

// A project whose CONVENTIONS.md records `selection` in its line-1 marker,
// regenerated to the canonical document for it.
const markerLine = (sel) => sel.mode === 'unset' ? '<!-- cc:conventions -->'
  : sel.mode === 'none' ? '<!-- cc:conventions :none -->'
  : `<!-- cc:conventions ${sel.slugs.join(',')} -->`;
async function projectWith(name, selection) {
  await createProject(name);
  await fs.writeFile(conventionsPath(name), `${markerLine(selection)}\n`);
  await ensureProjectConventionsMd(name);
}

// A project whose marker keeps `doomed`, a custom convention since deleted.
async function projectWithDeleted(name, others = ['design-guidelines']) {
  await addCustomConvention({ slug: 'doomed', name: 'Doomed', description: 'x', body: '## Doomed\n- rule' });
  await projectWith(name, selected('doomed', ...others));
  await deleteCustomConvention('doomed');
}

describe('PUT /api/projects/:name/conventions', () => {
  // PINS: the edit writes exactly what a sweep would for the new marker, so
  // the next sweep is a no-op, and answers the documented body.
  test('replaces the selection with the composed document', async () => {
    await projectWith('p', selected('design-guidelines'));
    const r = await put('p', { selection: selected('testing-guidelines', 'documentation-guidelines'), expected: selected('design-guidelines') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      ok: true, path: conventionsPath('p'),
      selection: selected('testing-guidelines', 'documentation-guidelines'), unresolved: [],
    });
    const want = await composeProjectConventionsDoc(selected('testing-guidelines', 'documentation-guidelines'));
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), want);
    await ensureProjectConventionsMd('p');
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), want, 'a sweep afterwards changes nothing');
  });

  // T4a — PINS: the edit writes exactly what a sweep writes for each state:
  // selected → none → selected → none → unset.
  test('writes none and unset as the sweep composes them, and leaves none for a selection', async () => {
    await projectWith('p', selected('design-guidelines'));
    let r = await put('p', { selection: NONE, expected: selected('design-guidelines') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.selection, NONE);
    assert.equal(await marker('p'), '<!-- cc:conventions :none -->');
    assert.deepEqual((await row('p')).conventions, { mode: 'none', unresolved: [] });
    const noneDoc = await composeProjectConventionsDoc(NONE);
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), noneDoc);

    r = await put('p', { selection: selected('testing-guidelines'), expected: NONE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), await composeProjectConventionsDoc(selected('testing-guidelines')));

    r = await put('p', { selection: NONE, expected: selected('testing-guidelines') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await put('p', { selection: UNSET, expected: NONE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.selection, UNSET);
    assert.equal(await marker('p'), '<!-- cc:conventions -->');
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), await composeProjectConventionsDoc(UNSET));
    assert.deepEqual((await row('p')).conventions, { mode: 'unset', unresolved: [] });
  });

  // PINS: a slug the catalog lacks but the marker already names is kept, in
  // request order, and the body names it as unavailable.
  test('keeps an unresolvable slug the file already names', async () => {
    await projectWithDeleted('p');
    const r = await put('p', { selection: selected('testing-guidelines', 'doomed'), expected: selected('doomed', 'design-guidelines') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.selection, selected('testing-guidelines', 'doomed'));
    assert.deepEqual(r.body.unresolved, ['doomed']);
    const content = await fs.readFile(conventionsPath('p'), 'utf8');
    assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions testing-guidelines,doomed -->');
    assert.match(content, /> Convention unavailable: `doomed`\./);
  });

  // PINS: an unresolvable slug can only be kept, never introduced.
  test('refuses a slug in neither the catalog nor the current marker, and writes nothing', async () => {
    await projectWith('p', selected('design-guidelines'));
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    const r = await put('p', { selection: selected('design-guidelines', 'no-such-slug'), expected: selected('design-guidelines') });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /no-such-slug/);
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before);
  });

  // PINS: the lost-update guard — `expected` must equal the file's marker.
  test('refuses a stale expected with 409 and writes nothing', async () => {
    await projectWith('p', selected('design-guidelines', 'testing-guidelines'));
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    const r = await put('p', { selection: selected('documentation-guidelines'), expected: selected('design-guidelines') });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /design-guidelines,testing-guidelines|design-guidelines, testing-guidelines/);
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before);
  });

  // PINS: the guard compares length, content and order — a longer expected
  // with the marker as its prefix is stale too.
  test('refuses an expected with different slugs, a different order or an extra trailing slug with 409 and writes nothing', async () => {
    await projectWith('p', selected('design-guidelines', 'testing-guidelines'));
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    for (const expected of [
      selected('design-guidelines', 'documentation-guidelines'),
      selected('testing-guidelines', 'design-guidelines'),
      selected('design-guidelines', 'testing-guidelines', 'documentation-guidelines'),
    ]) {
      const r = await put('p', { selection: selected('documentation-guidelines'), expected });
      assert.equal(r.status, 409, `${JSON.stringify(expected)} → ${JSON.stringify(r.body)}`);
      assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before, `${JSON.stringify(expected)}: file unchanged`);
    }
  });

  // T4b — PINS: the stale guard tells unset from none, in both directions.
  test('refuses an expected of unset against a none file, and of none against an unset file, with 409', async () => {
    await projectWith('chose', NONE);
    await projectWith('never', UNSET);
    const beforeChose = await fs.readFile(conventionsPath('chose'), 'utf8');
    const beforeNever = await fs.readFile(conventionsPath('never'), 'utf8');
    const a = await put('chose', { selection: selected('design-guidelines'), expected: UNSET });
    assert.equal(a.status, 409, JSON.stringify(a.body));
    assert.equal(await fs.readFile(conventionsPath('chose'), 'utf8'), beforeChose);
    const b = await put('never', { selection: selected('design-guidelines'), expected: NONE });
    assert.equal(b.status, 409, JSON.stringify(b.body));
    assert.equal(await fs.readFile(conventionsPath('never'), 'utf8'), beforeNever);
  });

  // PINS: the freeze rule holds for the edit — degraded + an unresolvable kept
  // slug is 503 CONVENTIONS_CATALOG_DEGRADED with the file byte-identical;
  // dropping that slug lets the same edit through.
  test('a degraded catalog refuses to keep an unresolvable slug, and allows dropping it', async () => {
    await projectWithDeleted('p');
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    setPluginConventionsProvider(async () => { throw new Error('transient plugin host failure'); });
    const refused = await put('p', { selection: selected('doomed', 'testing-guidelines'), expected: selected('doomed', 'design-guidelines') });
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'CONVENTIONS_CATALOG_DEGRADED');
    assert.match(refused.body.error, /doomed/);
    assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before, 'the file is left as it is');

    const allowed = await put('p', { selection: selected('testing-guidelines'), expected: selected('doomed', 'design-guidelines') });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(await marker('p'), '<!-- cc:conventions testing-guidelines -->');
  });

  // T4e — PINS: the 503 freeze only protects a write that keeps an
  // unresolvable slug; none is always writable.
  test('a degraded catalog lets a file keeping an unresolvable slug choose none', async () => {
    await projectWithDeleted('p');
    setPluginConventionsProvider(async () => { throw new Error('transient plugin host failure'); });
    const r = await put('p', { selection: NONE, expected: selected('doomed', 'design-guidelines') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await marker('p'), '<!-- cc:conventions :none -->');
  });

  // PINS: the edit writes through the project's System, keeping the System
  // disclosure a remote project's document carries.
  test('rewrites the file on a system project and keeps its System disclosure', async () => {
    const remote = await bindRemoteSystem();
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });
    await ensureProjectConventionsMd('app');
    const r = await put('app', { selection: selected('design-guidelines'), expected: UNSET });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const content = await fs.readFile(path.join(tree, 'CONVENTIONS.md'), 'utf8');
    assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions design-guidelines -->');
    assert.match(content, /^# System$/m);
    assert.match(content, /## Design guidelines/);
  });

  // T4c — PINS: none and slugs are never combined.
  test('refuses none or unset carrying slugs with 400 CONVENTIONS_NONE_WITH_SLUGS, and writes nothing', async () => {
    await projectWith('p', selected('design-guidelines'));
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    for (const selection of [{ mode: 'none', slugs: ['design-guidelines'] }, { mode: 'unset', slugs: [] }]) {
      const r = await put('p', { selection, expected: selected('design-guidelines') });
      assert.equal(r.status, 400, `${JSON.stringify(selection)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'CONVENTIONS_NONE_WITH_SLUGS');
      assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before);
    }
  });

  // T4d — PINS: the request body is unambiguous and checked before anything
  // is read; `expected` mirrors the marker, so only `selection` refuses a repeat.
  test('refuses a malformed body with 400 and writes nothing', async () => {
    await projectWith('p', UNSET);
    const before = await fs.readFile(conventionsPath('p'), 'utf8');
    for (const body of [
      { expected: UNSET },
      { selection: selected('design-guidelines') },
      { selection: ['design-guidelines'], expected: UNSET },
      { selection: selected('design-guidelines'), expected: [] },
      { selection: { mode: 'some' }, expected: UNSET },
      { selection: selected(), expected: UNSET },
      { selection: { mode: 'selected' }, expected: UNSET },
      { selection: selected(1), expected: UNSET },
      { selection: selected('design-guidelines'), expected: selected(null) },
      { selection: selected('design-guidelines', 'design-guidelines'), expected: UNSET },
    ]) {
      const r = await put('p', body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.equal(await fs.readFile(conventionsPath('p'), 'utf8'), before, `${JSON.stringify(body)}: file unchanged`);
    }
  });

  // PINS: `expected` is the marker verbatim, so a repeated slug there is a
  // legitimate expectation, not a malformed body.
  test('accepts an expected that repeats a slug the marker repeats', async () => {
    await projectWith('p', selected('design-guidelines', 'design-guidelines'));
    const r = await put('p', { selection: selected('testing-guidelines'), expected: selected('design-guidelines', 'design-guidelines') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await marker('p'), '<!-- cc:conventions testing-guidelines -->');
  });

  // PINS: an unknown project is 404, not a write somewhere.
  test('answers 404 for an unknown project', async () => {
    const r = await put('nope', { selection: UNSET, expected: UNSET });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
});

// T3 — PINS: the payload carries all three states distinctly.
describe('GET /api/projects conventions field', () => {
  // PINS: an absent file reads as unset.
  test('no CONVENTIONS.md → unset', async () => {
    await createProject('p');
    await fs.rm(conventionsPath('p'), { force: true });
    assert.deepEqual((await row('p')).conventions, { mode: 'unset', unresolved: [] });
  });

  // PINS: a first line that is not a marker reads as unset.
  test('a non-marker first line → unset', async () => {
    await createProject('p');
    await fs.writeFile(conventionsPath('p'), '# My own conventions\n');
    assert.deepEqual((await row('p')).conventions, { mode: 'unset', unresolved: [] });
  });

  // PINS: a zero-slug marker reads as unset.
  test('a zero-slug marker → unset', async () => {
    await projectWith('p', UNSET);
    assert.deepEqual((await row('p')).conventions, { mode: 'unset', unresolved: [] });
  });

  // PINS: the reserved none marker reads as none.
  test('a none marker → none', async () => {
    await projectWith('p', NONE);
    assert.deepEqual((await row('p')).conventions, { mode: 'none', unresolved: [] });
  });

  // PINS: marker order is kept, and `unresolved` names exactly the slugs the
  // current catalog lacks.
  test('marker slugs in order, unresolved naming the deleted custom one', async () => {
    await projectWithDeleted('p', ['testing-guidelines', 'design-guidelines']);
    assert.deepEqual((await row('p')).conventions, {
      mode: 'selected', slugs: ['doomed', 'testing-guidelines', 'design-guidelines'], unresolved: ['doomed'],
    });
  });

  // PINS: a read that fails other than ENOENT is reported as {error} on that
  // row, and the listing still answers for every project.
  test('an unreadable CONVENTIONS.md → {error}, and the rest of the list still answers', async () => {
    await projectWith('healthy', selected('design-guidelines'));
    await createProject('broken');
    await fs.rm(conventionsPath('broken'), { force: true });
    await fs.mkdir(conventionsPath('broken'));
    const r = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const broken = r.body.find(p => p.name === 'broken');
    assert.deepEqual(Object.keys(broken.conventions), ['error']);
    assert.equal(typeof broken.conventions.error, 'string');
    assert.ok(broken.conventions.error.length > 0);
    assert.deepEqual(r.body.find(p => p.name === 'healthy').conventions, { mode: 'selected', slugs: ['design-guidelines'], unresolved: [] });
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
  await projectWith('p', selected('design-guidelines'));
  const pending = [];
  setPluginConventionsProvider(() => new Promise((resolve) => { pending.push(() => resolve([])); }));
  let settled = 0;
  const sweep = ensureProjectConventionsMd('p').finally(() => { settled++; });
  // The sweep has read the old marker and is held at its catalog read.
  await waitFor(() => pending.length === 1);
  const edit = setProjectConventions('p', selected('testing-guidelines'), selected('design-guidelines')).finally(() => { settled++; });
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
