// The system REGISTRY: the `systems` settings namespace and its REST surface.
//
// A system row is REGISTRATION ONLY — it names an execution environment; this
// phase never connects to one. What the tests pin is therefore the record
// contract, not any behaviour on a system:
//   - `local` is code-authoritative: always present, never persisted, not
//     editable, not deletable. A store that could lose it could strand every
//     project.
//   - Removal never cascades: a system a project record still NAMES is refused
//     409 with those projects in the message.
//   - The still-referenced check keys on the record's `system` field, so the
//     store's stale directories (it holds dirs for projects that no longer
//     exist) cannot make a system undeletable.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  getSystems, getSystem, isKnownSystem, addSystem, updateSystem, removeSystem,
} from '../src/appSettings.ts';
import { orchStoreRoot, projectStoreDir, createProject } from '../src/projects.ts';
import { MANAGED_SYSTEMS, MANAGED_SYSTEM_IDS, LOCAL_SYSTEM_ID } from '../src/systems/registry.ts';

async function writeRecord(name, record) {
  const dir = projectStoreDir(name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(record, null, 2) + '\n');
}

const settingsFile = () => path.join(orchStoreRoot(), 'settings.json');
async function readSettings() {
  try { return JSON.parse(await fs.readFile(settingsFile(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Plant a hand-edited settings.json — the only way the malformed shapes below
// can exist, since the API refuses them.
//
// IT MUST RUN BEFORE THE FIRST appSettings CALL UNDER THIS PROJECTS ROOT.
// appSettings caches the parsed document keyed by settingsPath(), so the cache
// is cold exactly once per freshProjectsRoot() and a direct write AFTER any
// read/write goes unseen — which would make every assertion below pass against
// the pre-edit state, i.e. against nothing.
async function seedSettings(doc) {
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(doc, null, 2));
}

describe('the systems namespace', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await rmrf(home); });

  test('local is present with no settings.json at all, and is never persisted', async () => {
    assert.equal(await readSettings(), null, 'a fresh install has no settings file');
    assert.deepEqual(getSystems(), [{ id: LOCAL_SYSTEM_ID, label: 'This machine', managed: true }]);
    assert.deepEqual(MANAGED_SYSTEM_IDS, [LOCAL_SYSTEM_ID]);
    assert.equal(getSystem(LOCAL_SYSTEM_ID).managed, true);
    assert.equal(isKnownSystem(LOCAL_SYSTEM_ID), true);
    assert.equal(isKnownSystem('prod-box'), false);

    // Adding a user row writes ONLY that row — the managed one stays in code.
    await addSystem({ id: 'prod-box', label: 'Prod box' });
    assert.deepEqual((await readSettings()).systems.registry, [{ id: 'prod-box', label: 'Prod box' }]);
    assert.deepEqual(getSystems().map(s => s.id), [LOCAL_SYSTEM_ID, 'prod-box']);
  });

  test('a stored row that shadows a managed id is ignored, label/id from code', async () => {
    // Hand-edited (or migrated-from) state must not be able to rename or
    // repoint the built-in row.
    await seedSettings({ systems: { registry: [
      { id: LOCAL_SYSTEM_ID, label: 'Pwned' },
      { id: 'prod-box', label: 'Prod box' },
    ] } });

    const list = getSystems();
    assert.deepEqual(list.map(s => s.id), [LOCAL_SYSTEM_ID, 'prod-box'], 'no duplicate row');
    assert.equal(list[0].label, MANAGED_SYSTEMS[0].label, 'the label comes from code, not the store');
    assert.equal(list[0].managed, true);
  });

  test('duplicate user rows in a hand-edited store collapse to one, first wins', async () => {
    // addSystem's 409 keeps a duplicate out of the store, so this is only
    // reachable by hand-editing settings.json. Rendering the id twice would give
    // the panel two rows that Edit and Remove interchangeably.
    await seedSettings({ systems: { registry: [
      { id: 'prod-box', label: 'Prod box' },
      { id: 'prod-box', label: 'Impostor' },
    ] } });

    assert.deepEqual(getSystems().map(s => s.id), [LOCAL_SYSTEM_ID, 'prod-box'], 'one row per id');
    assert.equal(getSystem('prod-box').label, 'Prod box', 'first wins, matching what the writers do');
    // And removing it removes BOTH stored rows, so the ghost cannot resurface.
    assert.equal(await removeSystem('prod-box'), true);
    assert.deepEqual(getSystems().map(s => s.id), [LOCAL_SYSTEM_ID]);
  });

  test('the managed row refuses every mutation', async () => {
    await assert.rejects(() => addSystem({ id: LOCAL_SYSTEM_ID, label: 'Mine' }),
      (e) => e.statusCode === 409);
    await assert.rejects(() => updateSystem(LOCAL_SYSTEM_ID, { label: 'Renamed' }),
      (e) => e.statusCode === 400 && /built in/.test(e.message));
    await assert.rejects(() => removeSystem(LOCAL_SYSTEM_ID),
      (e) => e.statusCode === 400 && /built in/.test(e.message));
    // A no-op PATCH is not a mutation and is allowed through unchanged.
    assert.deepEqual(await updateSystem(LOCAL_SYSTEM_ID, {}), MANAGED_SYSTEMS[0]);
    assert.equal(getSystem(LOCAL_SYSTEM_ID).label, MANAGED_SYSTEMS[0].label);
  });

  test('ids are slugs, labels are required, duplicates refused', async () => {
    for (const bad of ['Prod-Box', 'prod box', '1box', '', 'a'.repeat(41)]) {
      await assert.rejects(() => addSystem({ id: bad, label: 'X' }), (e) => e.statusCode === 400,
        `id '${bad}' must be refused`);
    }
    await assert.rejects(() => addSystem({ id: 'prod-box', label: '  ' }),
      (e) => e.statusCode === 400 && /label is required/.test(e.message));
    await addSystem({ id: 'prod-box', label: 'Prod box' });
    await assert.rejects(() => addSystem({ id: 'prod-box', label: 'Again' }), (e) => e.statusCode === 409);
    // Nothing was written by any refusal.
    assert.deepEqual(getSystems().map(s => s.id), [LOCAL_SYSTEM_ID, 'prod-box']);
  });

  test('a user row renames, and removes once nothing names it', async () => {
    await addSystem({ id: 'prod-box', label: 'Prod box' });
    assert.deepEqual(await updateSystem('prod-box', { label: 'Production' }),
      { id: 'prod-box', label: 'Production', managed: false });
    assert.equal(await updateSystem('ghost', { label: 'x' }), null, 'unknown id → null, the 404 signal');
    assert.equal(await removeSystem('ghost'), false);
    assert.equal(await removeSystem('prod-box'), true);
    assert.equal(isKnownSystem('prod-box'), false);
  });

  test('removal is REFUSED 409 while a project record names the system', async () => {
    await addSystem({ id: 'prod-box', label: 'Prod box' });
    await createProject('shipping');
    await writeRecord('shipping', { system: 'prod-box', systemPath: '/app' });
    await createProject('billing');
    await writeRecord('billing', { system: 'prod-box', systemPath: '/srv/billing' });

    await assert.rejects(() => removeSystem('prod-box'), (e) => {
      assert.equal(e.statusCode, 409);
      // The message must NAME them — "2 projects" alone leaves the user with no
      // way to find what to move.
      assert.match(e.message, /billing/);
      assert.match(e.message, /shipping/);
      return true;
    });
    assert.ok(isKnownSystem('prod-box'), 'nothing removed on refusal');

    // Clearing the records releases it.
    await fs.rm(path.join(projectStoreDir('shipping'), 'project.json'));
    await fs.rm(path.join(projectStoreDir('billing'), 'project.json'));
    assert.equal(await removeSystem('prod-box'), true);
  });

  test('a stale store directory cannot hold a system hostage', async () => {
    await addSystem({ id: 'prod-box', label: 'Prod box' });
    // The store keeps directories for projects that no longer exist. One with a
    // record that names NO system is not a reference — the check keys on the
    // positive marker, which is exactly why no backfill may stamp `local`.
    await writeRecord('long-gone', { workspace: 'Old' });
    await fs.mkdir(projectStoreDir('also-gone'), { recursive: true });
    assert.equal(await removeSystem('prod-box'), true);
  });
});

describe('systems settings routes', () => {
  let ctx, baseUrl, home;
  before(async () => { ctx = await bootServer(); baseUrl = ctx.baseUrl; });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

  test('GET ships the registry with each row\'s referencing projects', async () => {
    const empty = await api(baseUrl, 'GET', '/api/settings/systems');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.systems,
      [{ id: LOCAL_SYSTEM_ID, label: 'This machine', managed: true, projects: [] }]);

    await api(baseUrl, 'POST', '/api/settings/systems', { id: 'prod-box', label: 'Prod box' });
    await createProject('shipping');
    await writeRecord('shipping', { system: 'prod-box', systemPath: '/app' });
    const r = await api(baseUrl, 'GET', '/api/settings/systems');
    assert.deepEqual(r.body.systems.find(s => s.id === 'prod-box').projects, ['shipping']);
    // `local` never accumulates referents: a local project carries no field.
    assert.deepEqual(r.body.systems.find(s => s.id === LOCAL_SYSTEM_ID).projects, []);
  });

  test('CRUD routes: 201/409/400 on add, 400/404 on patch, the 409/400/404 delete contract', async () => {
    const add = await api(baseUrl, 'POST', '/api/settings/systems', { id: 'prod-box', label: 'Prod box' });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.deepEqual(add.body.added, { id: 'prod-box', label: 'Prod box', managed: false });
    assert.deepEqual(add.body.systems.map(s => s.id), [LOCAL_SYSTEM_ID, 'prod-box']);

    assert.equal((await api(baseUrl, 'POST', '/api/settings/systems', { id: 'prod-box', label: 'X' })).status, 409);
    assert.equal((await api(baseUrl, 'POST', '/api/settings/systems', { id: 'Nope!', label: 'X' })).status, 400);
    assert.equal((await api(baseUrl, 'POST', '/api/settings/systems', { id: 'plain' })).status, 400);

    const patch = await api(baseUrl, 'PATCH', '/api/settings/systems/prod-box', { label: 'Production' });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.updated.label, 'Production');
    const patchManaged = await api(baseUrl, 'PATCH', `/api/settings/systems/${LOCAL_SYSTEM_ID}`, { label: 'Mine' });
    assert.equal(patchManaged.status, 400);
    assert.match(patchManaged.body.error, /built in/);
    assert.equal((await api(baseUrl, 'PATCH', '/api/settings/systems/ghost', { label: 'x' })).status, 404);

    await createProject('shipping');
    await writeRecord('shipping', { system: 'prod-box', systemPath: '/app' });
    const refused = await api(baseUrl, 'DELETE', '/api/settings/systems/prod-box');
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /shipping/);

    assert.equal((await api(baseUrl, 'DELETE', `/api/settings/systems/${LOCAL_SYSTEM_ID}`)).status, 400);
    assert.equal((await api(baseUrl, 'DELETE', '/api/settings/systems/ghost')).status, 404);

    await fs.rm(path.join(projectStoreDir('shipping'), 'project.json'));
    const gone = await api(baseUrl, 'DELETE', '/api/settings/systems/prod-box');
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body.systems.map(s => s.id), [LOCAL_SYSTEM_ID]);
  });
});
