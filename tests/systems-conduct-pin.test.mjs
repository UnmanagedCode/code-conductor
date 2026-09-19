// THE PIN TEST: `.conduct` resolves to the local system no matter what its own
// record says.
//
// `.conduct` is pinned local unconditionally, ahead of any record lookup. Until
// now that pin was VACUOUS: no record could name a system, so every project
// resolved local anyway and deleting the pin changed nothing. This phase adds
// exactly the records that can contradict it, so the pin becomes load-bearing —
// and the tests below are written to FAIL if the pin line is removed, which is
// the only version of this test worth having.
//
// The contradiction is constructed, not hypothetical: each test writes
// `<store>/projects/.conduct/project.json` claiming the orchestrator's own
// project lives at `/app` on `prod-box`, then asserts every reader ignores it.
// With the pin gone, `resolveSystem` reaches its refusal for an unreachable
// system and each of these throws.
//
// The store half of the same invariant is here too: a project that IS on
// another system keeps its record, and every read/write of that record, on the
// LOCAL disk under `<store>/projects/<name>/`.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  orchStoreRoot, projectStoreDir, projectsRoot, projectsBySystem,
  readProjectRecord, writeProjectMeta, createProject, listProjects,
} from '../src/projects.ts';
import {
  CONDUCT_PROJECT_NAME, LOCAL_SYSTEM_ID, placementOf, projectPlacement, resolveSystem,
} from '../src/systems/registry.ts';
import { ensureConductProject, conductProjectPath } from '../src/conduct.ts';

let home;
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await rmrf(home); });

// The record a hostile/confused writer would leave: the orchestrator's own
// project claimed to live on another machine.
async function writeRecord(name, record) {
  const dir = projectStoreDir(name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(record, null, 2) + '\n');
}

const REMOTE_LOCATION = { kind: 'remote', system: 'prod-box', remoteId: 'ctr-7', path: '/app' };
const REMOTE = { workspace: 'CTF', location: REMOTE_LOCATION };

test('a record claiming .conduct is on another system is IGNORED by the pin', async () => {
  await writeRecord(CONDUCT_PROJECT_NAME, REMOTE);
  // The record really is on disk and really does say prod-box — otherwise the
  // assertions below would pass against nothing.
  assert.deepEqual(await readProjectRecord(CONDUCT_PROJECT_NAME), REMOTE);

  // The MACHINE is pinned, the target included: a record naming both a system
  // and a target on it is ignored whole, not narrowed. The PATH is still the
  // record's — the pin is about which machine, and `.conduct`'s own bootstrap
  // is what writes that path.
  assert.deepEqual(await projectPlacement(CONDUCT_PROJECT_NAME),
    { system: LOCAL_SYSTEM_ID, remoteId: null, path: '/app' });
  // Without the pin this THROWS (501: no transport to prod-box).
  assert.equal((await resolveSystem(CONDUCT_PROJECT_NAME)).id, LOCAL_SYSTEM_ID);
  // The pin is name-based, not record-based: an empty record proves nothing, so
  // the contradicting one above is the whole test. Any other project with the
  // same record is NOT pinned — that asymmetry is what the pin means.
  assert.deepEqual(placementOf('other', REMOTE_LOCATION),
    { system: 'prod-box', remoteId: 'ctr-7', path: '/app' });
});

test('ensureConductProject still bootstraps LOCALLY against a contradicting record', async () => {
  await writeRecord(CONDUCT_PROJECT_NAME, REMOTE);
  // Phase 1 routed this through resolveSystem deliberately: it is the one call
  // that both proves and uses the pin. With the pin removed it throws.
  const { path: dir, created } = await ensureConductProject();
  assert.equal(created, true);
  assert.equal(dir, path.join(projectsRoot(), CONDUCT_PROJECT_NAME));
  assert.equal(dir, conductProjectPath());
  // Under projectsRoot(), not under the `/app` its record named.
  assert.equal((await fs.stat(dir)).isDirectory(), true);
  assert.ok(!dir.startsWith('/app'), 'the record never relocates the orchestrator');
  // And the CLAUDE.md import was written there, through the local system.
  assert.match(await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8'), /@CONVENTIONS\.md/);
});

test('the still-referenced scan never counts .conduct onto a system', async () => {
  await writeRecord(CONDUCT_PROJECT_NAME, REMOTE);
  await writeRecord('shipping', REMOTE);
  // Both records say prod-box. Only the one that is not pinned is a reference —
  // so a `prod-box` row is deletable once `shipping` moves, and `.conduct` can
  // never make a system undeletable.
  assert.deepEqual(await projectsBySystem(), { 'prod-box': [{ name: 'shipping', remoteId: 'ctr-7' }] });
});

test("cc's own store stays local for a project that IS on another system", async () => {
  await writeRecord('shipping', REMOTE);
  const file = path.join(orchStoreRoot(), 'projects', 'shipping', 'project.json');
  assert.equal((await fs.stat(file)).isFile(), true, 'the record lives under the local store');

  // Its tree is unreachable, but its RECORD is cc's own bookkeeping and is read
  // from the local store like any other.
  assert.deepEqual(await readProjectRecord('shipping'), REMOTE);
  await assert.rejects(() => resolveSystem('shipping'), /prod-box/);
});

test('an unrelated write PRESERVES the record\'s location', async () => {
  // The field-dropping hazard: writeProjectMeta merges over what the reader
  // returns, so a location the reader forgot would be DELETED by the next
  // unrelated write (a workspace change) — and with the location gone the
  // project is UNREGISTERED.
  //
  // Driven on `.conduct` because it is the one project that can carry a
  // non-local record AND still be written this phase: a genuinely remote
  // project's tree is unreachable, so getProject (which writeProjectMeta calls)
  // refuses it until the transport lands. The pin is what makes this reachable
  // — with the pin removed this throws before it can assert anything.
  await ensureConductProject();
  await writeRecord(CONDUCT_PROJECT_NAME, REMOTE);
  await writeProjectMeta(CONDUCT_PROJECT_NAME, { workspace: 'Other' });
  assert.deepEqual(await readProjectRecord(CONDUCT_PROJECT_NAME),
    { workspace: 'Other', location: REMOTE_LOCATION });
  // Still not a reference: the pin outranks the record it just preserved.
  assert.deepEqual(await projectsBySystem(), {});
});

test('a project on another system is listed with it, and refuses to resolve', async () => {
  await createProject('shipping');
  await writeRecord('shipping', REMOTE);
  const shipping = (await listProjects()).find(p => p.name === 'shipping');
  assert.deepEqual({ system: shipping.system, remoteId: shipping.remoteId, path: shipping.path },
    { system: 'prod-box', remoteId: 'ctr-7', path: '/app' });
  assert.deepEqual(await projectsBySystem(), { 'prod-box': [{ name: 'shipping', remoteId: 'ctr-7' }] });
  // No transport yet, so the ONE thing that must not happen is resolving local
  // and operating on `<projectsRoot>/shipping` as if it were the tree.
  await assert.rejects(() => resolveSystem('shipping'), (e) => {
    assert.equal(e.statusCode, 501);
    assert.match(e.message, /prod-box/);
    return true;
  });
});

// INVERTED from "a local project gets NO project.json": every project has a
// record now, because the record IS the registration. What stays true is that
// READING a project's system is not a WRITE — a resolution that stamped the
// record would rewrite it on every listing.
test("reading a project's system does not WRITE its record", async () => {
  await createProject('plain');
  const file = path.join(projectStoreDir('plain'), 'project.json');
  const before = await fs.readFile(file, 'utf8');
  const beforeMtime = (await fs.stat(file)).mtimeMs;

  const listed = await listProjects();
  const plain = listed.find(p => p.name === 'plain');
  assert.deepEqual({ system: plain.system, remoteId: plain.remoteId, path: plain.path },
    { system: LOCAL_SYSTEM_ID, remoteId: null, path: path.join(projectsRoot(), 'plain') });
  assert.equal((await resolveSystem('plain')).id, LOCAL_SYSTEM_ID);
  await projectPlacement('plain');

  assert.equal(await fs.readFile(file, 'utf8'), before, 'the record is byte-identical');
  assert.equal((await fs.stat(file)).mtimeMs, beforeMtime, 'and was not rewritten');
});
