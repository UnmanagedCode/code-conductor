// The PERSISTED default playbook enforcement level (Settings → Conductor
// conventions) and the path by which a newly spawned conductor inherits it.
//
// Three properties, each with a specific way of going wrong that a lazier test
// would miss:
//
//  1. STORE. The level rides conventions/conductor.json as a sibling of
//     `defaultPlaybook`, so the two must not clobber each other; and the read
//     path must keep normalizePlaybookEnforcement's retired-'off'→'warn' rule.
//     That assertion only discriminates because DEFAULT_PLAYBOOK_ENFORCEMENT is
//     'enforce' — 'off' landing on the default would be the WRONG answer here,
//     and the test says so explicitly rather than leaving it to the reader.
//  2. INHERITANCE. A conductor spawned with no explicit playbookEnforcement
//     starts at the persisted level; an explicit one still wins (the restart
//     path in src/resumeRestart.ts depends on that).
//  3. THE TOGGLE IS NOT A SAVE. The ⋮ control flips the live instance over the
//     WebSocket and must leave the store byte-identical. The store is SEEDED
//     with a known non-default value first: a test run against a store file that
//     never existed would pass no matter what the WS path wrote.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, freshProjectsRoot, waitFor, rmrf } from './helpers.mjs';
import {
  getDefaultPlaybookEnforcement, setDefaultPlaybookEnforcement,
  getDefaultPlaybookSelection, setDefaultPlaybook,
} from '../src/conductorConventions.ts';
import { DEFAULT_PLAYBOOK_ENFORCEMENT, PLAYBOOK_ENFORCEMENT_MODES } from '../src/playbooks.ts';
import { orchStoreRoot } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-ws.json');

// The one non-default level, derived rather than written literally: were the
// shipped default ever flipped, these tests must keep testing a real change.
const OTHER = PLAYBOOK_ENFORCEMENT_MODES.find(m => m !== DEFAULT_PLAYBOOK_ENFORCEMENT);

let ctx, baseUrl, instances, home;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot; ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

const storePath = () => path.join(orchStoreRoot(), 'conventions', 'conductor.json');
const storeJson = async () => JSON.parse(await fs.readFile(storePath(), 'utf8'));
const writeStore = async (obj) => {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(obj, null, 2) + '\n');
};

// A live conductor, spawned the way the UI spawns one.
async function spawnConductor(body = {}) {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const spawned = await api(baseUrl, 'POST', '/api/instances',
    { project: '.conduct', mode: 'bypassPermissions', temp: true, ...body });
  assert.equal(spawned.status, 201, `conductor spawn failed: ${JSON.stringify(spawned.body)}`);
  return spawned.body.id;
}

// ── store ────────────────────────────────────────────────────────────────────

test('an unset key reads as the shipped default and both levels round-trip', async () => {
  assert.equal(await getDefaultPlaybookEnforcement(), DEFAULT_PLAYBOOK_ENFORCEMENT);

  assert.equal(await setDefaultPlaybookEnforcement(OTHER), OTHER);
  assert.equal(await getDefaultPlaybookEnforcement(), OTHER);
  assert.equal((await storeJson()).defaultPlaybookEnforcement, OTHER, 'persisted, not just remembered');

  assert.equal(await setDefaultPlaybookEnforcement(DEFAULT_PLAYBOOK_ENFORCEMENT), DEFAULT_PLAYBOOK_ENFORCEMENT);
  assert.equal(await getDefaultPlaybookEnforcement(), DEFAULT_PLAYBOOK_ENFORCEMENT);
});

test("a persisted legacy 'off' reads as warn, NOT as the default", async () => {
  await writeStore({ defaultPlaybookEnforcement: 'off' });
  // The assertion discriminates precisely because the shipped default is
  // 'enforce': 'off' → 'warn' is a downgrade-preserving read, and 'off' →
  // DEFAULT_PLAYBOOK_ENFORCEMENT would be the silent upgrade the rule forbids.
  assert.equal(DEFAULT_PLAYBOOK_ENFORCEMENT, 'enforce', 'this test only proves anything while the default is enforce');
  assert.equal(await getDefaultPlaybookEnforcement(), 'warn');
});

test('an unknown level and the retired off are both unwritable, and leave the stored value alone', async () => {
  await setDefaultPlaybookEnforcement(OTHER);
  for (const bad of ['off', 'nope', '', 42, null, undefined]) {
    await assert.rejects(() => setDefaultPlaybookEnforcement(bad), e => {
      assert.equal(e.statusCode, 400);
      assert.match(e.message, /mode must be one of warn \| enforce/);
      return true;
    }, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(await getDefaultPlaybookEnforcement(), OTHER, 'the stored level survived every refusal');
});

test('the enforcement level and the default-playbook selection are independent keys', async () => {
  await setDefaultPlaybook({ mode: 'playbook', id: 'solo' });
  await setDefaultPlaybookEnforcement(OTHER);
  assert.deepEqual(await getDefaultPlaybookSelection(), { mode: 'playbook', id: 'solo' },
    'writing the level did not clobber the selection');

  await setDefaultPlaybook({ mode: 'none' });
  assert.equal(await getDefaultPlaybookEnforcement(), OTHER,
    'writing the selection did not clobber the level');

  const store = await storeJson();
  assert.deepEqual(store.defaultPlaybook, { mode: 'none' });
  assert.equal(store.defaultPlaybookEnforcement, OTHER);
});

// ── REST ─────────────────────────────────────────────────────────────────────

test('GET conductor conventions carries the level and the mode allow-list', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/conventions/conductor');
  assert.equal(r.status, 200);
  assert.equal(r.body.defaultPlaybookEnforcement, DEFAULT_PLAYBOOK_ENFORCEMENT);
  // The picker builds its rows from this, so the allow-list must cross the wire
  // rather than being hardcoded client-side.
  assert.deepEqual(r.body.playbookEnforcementModes, [...PLAYBOOK_ENFORCEMENT_MODES]);
});

test('PUT default-playbook-enforcement round-trips and refuses an unknown level', async () => {
  const put = (body) =>
    api(baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook-enforcement', body);
  const get = async () =>
    (await api(baseUrl, 'GET', '/api/settings/conventions/conductor')).body.defaultPlaybookEnforcement;

  let r = await put({ mode: OTHER });
  assert.equal(r.status, 200);
  assert.equal(r.body.defaultPlaybookEnforcement, OTHER);
  assert.equal(await get(), OTHER);

  // Must not be swallowed by the /:slug route — that would 404 as an unknown
  // convention instead of validating the level.
  r = await put({ mode: 'off' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /mode must be one of warn \| enforce/);
  assert.equal(await get(), OTHER, 'the level survived the refusal');
});

test('PUT default-playbook-enforcement with no `mode` key is a 400, not a silent change', async () => {
  await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook-enforcement', { mode: OTHER });
  const r = await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook-enforcement', {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /mode is required/);
  assert.equal((await api(baseUrl, 'GET', '/api/settings/conventions/conductor')).body.defaultPlaybookEnforcement,
    OTHER, 'the level survived the malformed request');
});

// ── inheritance at spawn ─────────────────────────────────────────────────────

test('a conductor spawned with no explicit level starts at the persisted default', async () => {
  await setDefaultPlaybookEnforcement(OTHER);
  const id = await spawnConductor();
  assert.equal(instances.get(id).playbookEnforcement, OTHER);
  // It reaches the client too — the gate ledgers off the status stream.
  assert.equal(instances.get(id).summary().playbookEnforcement, OTHER);
});

test('with nothing persisted a conductor falls back to DEFAULT_PLAYBOOK_ENFORCEMENT', async () => {
  const id = await spawnConductor();
  assert.equal(instances.get(id).playbookEnforcement, DEFAULT_PLAYBOOK_ENFORCEMENT);
});

test('an explicit spawn level beats the persisted default', async () => {
  await setDefaultPlaybookEnforcement(OTHER);
  const id = await spawnConductor({ playbookEnforcement: DEFAULT_PLAYBOOK_ENFORCEMENT });
  assert.equal(instances.get(id).playbookEnforcement, DEFAULT_PLAYBOOK_ENFORCEMENT,
    'the restart path carries a session its own recorded level; the default must not override it');
});

test('the persisted level is read live — a change lands on the next spawn, no restart', async () => {
  const first = await spawnConductor();
  assert.equal(instances.get(first).playbookEnforcement, DEFAULT_PLAYBOOK_ENFORCEMENT);
  await setDefaultPlaybookEnforcement(OTHER);
  const second = await spawnConductor();
  assert.equal(instances.get(second).playbookEnforcement, OTHER, 'no server restart needed');
  assert.equal(instances.get(first).playbookEnforcement, DEFAULT_PLAYBOOK_ENFORCEMENT,
    'the already-running conductor is untouched');
});

test('a non-conductor instance is unaffected by the setting', async () => {
  await setDefaultPlaybookEnforcement(OTHER);
  await fs.mkdir(path.join(ctx.projectsRoot, 'demo'), { recursive: true });
  const spawned = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', temp: true });
  assert.equal(spawned.status, 201, JSON.stringify(spawned.body));
  assert.equal(instances.get(spawned.body.id).playbookEnforcement, DEFAULT_PLAYBOOK_ENFORCEMENT,
    'the field is never read off a worker; it keeps the constructor value');
});

// ── the ⋮ toggle is a session override, not a save ───────────────────────────

test('flipping enforcement over the WebSocket changes the session and NOT the store', async () => {
  // Seed a known, non-default stored level FIRST. Without this the store file
  // would not exist and "unchanged" would be vacuously true whatever the WS
  // path did.
  await setDefaultPlaybookEnforcement(OTHER);
  const before = await fs.readFile(storePath(), 'utf8');
  assert.match(before, new RegExp(`"defaultPlaybookEnforcement": "${OTHER}"`),
    'the seed must actually be on disk for the comparison below to bite');

  const id = await spawnConductor();
  assert.equal(instances.get(id).playbookEnforcement, OTHER);

  const ack = await new Promise((resolve, reject) => {
    const ws = new WebSocket(ctx.wsUrl);
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({
      t: 'playbook_enforcement', id, mode: DEFAULT_PLAYBOOK_ENFORCEMENT, reqId: 'r1',
    })));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'ack' && m.reqId === 'r1') { ws.close(); resolve(m); }
    });
  });
  assert.equal(ack.ok, true);
  assert.equal(instances.get(id).playbookEnforcement, DEFAULT_PLAYBOOK_ENFORCEMENT, 'the session flipped');

  // Give any (wrong) write a real chance to land before reading back.
  await assert.rejects(
    () => waitFor(async () => (await fs.readFile(storePath(), 'utf8')) !== before, { timeout: 500, interval: 20 }),
    /timeout/,
    'the ⋮ toggle must not write the persisted default');
  assert.equal(await getDefaultPlaybookEnforcement(), OTHER, 'the persisted default is still the seeded value');

  // And it really is only an override: the next conductor starts at the stored
  // level again, not at whatever the previous session was toggled to.
  const next = await spawnConductor();
  assert.equal(instances.get(next).playbookEnforcement, OTHER);
});
