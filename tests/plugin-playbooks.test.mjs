// Plugin-contributed playbooks through the shared loader, the pure policy
// decision and the preferred-playbook convention — everything below the plugin
// host, driven through setPluginPlaybooksProvider exactly as server.ts wires it.
// The host side (manifest read, enable/disable, rescan) is in
// tests/plugins-registry.test.mjs; the end-to-end wiring is in
// tests/plugin-playbooks-e2e.test.mjs.

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPlaybooks, decide, setPluginPlaybooksProvider, SEED_PLAYBOOK_IDS,
} from '../src/playbooks.ts';
import { setPluginRolesProvider, isResolvableRole } from '../src/appSettings.ts';
import {
  SEED_CONVENTIONS, setSelection, composeCurrentConduct,
  getDefaultPlaybookSelection, setDefaultPlaybook, defaultPlaybookMissing,
} from '../src/conductorConventions.ts';
import { freshProjectsRoot } from './helpers.mjs';
import { proj, isLiveFromEvents } from './playbook-fixtures.mjs';

// A plugin graph whose entry stage pins its OWN plugin's role, and a second
// stage reached by a declared edge.
const RELEASE = {
  id: 'release', name: 'Acme release', description: 'Plan a release, then ship it.',
  entryStages: ['plan'],
  stages: {
    plan: { tools: { spawn_instance: { pin: { model: 'acme/captain' } } } },
    ship: { needs: [{ stage: 'plan', liveness: 'any' }], tools: { spawn_instance: 'allow' } },
  },
  transitions: [{ from: 'plan', to: 'ship' }],
};

const record = (plugin, def, { slug = def.id, body = JSON.stringify(def) } = {}) =>
  ({ id: `${plugin}/${slug}`, slug, plugin, body });

function provide(records) {
  setPluginPlaybooksProvider(async () => records);
}

before(async () => { await freshProjectsRoot(); });
afterEach(() => {
  setPluginPlaybooksProvider(null);
  setPluginRolesProvider(null);
});

// ── the loader ──────────────────────────────────────────────────────────────

test('a valid plugin record loads under its namespaced id with `plugin`, beside a same-slug built-in', async () => {
  // `relay` is a built-in id; the plugin's `relay` must coexist with it.
  const relayDef = { ...RELEASE, id: 'relay', name: 'Acme relay' };
  provide([record('acme', RELEASE), record('x', relayDef)]);
  const { playbooks, errors } = await loadPlaybooks();
  assert.deepEqual(errors, []);
  const pb = playbooks.get('acme/release');
  assert.ok(pb, 'the plugin playbook is loaded');
  assert.equal(pb.id, 'acme/release');
  assert.equal(pb.plugin, 'acme');
  assert.equal(playbooks.get('x/relay')?.name, 'Acme relay');
  assert.equal(playbooks.get('relay')?.plugin, undefined, 'the built-in relay is untouched and carries no plugin');
  assert.notEqual(playbooks.get('relay')?.name, 'Acme relay');
});

test("a body whose id is not its manifest slug is rejected, keyed by the namespaced id", async () => {
  provide([record('acme', { ...RELEASE, id: 'other' }, { slug: 'release' })]);
  const { playbooks, errors } = await loadPlaybooks();
  assert.equal(playbooks.has('acme/release'), false);
  const mine = errors.filter(e => e.id === 'acme/release');
  assert.ok(mine.some(e => /id 'other' does not match its manifest slug 'release'/.test(e.message)),
    JSON.stringify(errors));
});

test('malformed JSON in one plugin record rejects that record only', async () => {
  provide([
    record('acme', RELEASE, { body: '{ nope' }),
    record('bee', { ...RELEASE, id: 'flow' }),
  ]);
  const { playbooks, errors } = await loadPlaybooks();
  assert.deepEqual(errors.map(e => e.id), ['acme/release']);
  assert.match(errors[0].message, /not valid JSON/);
  for (const id of SEED_PLAYBOOK_IDS) assert.ok(playbooks.has(id), `built-in '${id}' still loads`);
  assert.ok(playbooks.has('bee/flow'), "another plugin's valid playbook still loads");
});

test('a throwing provider costs only plugin playbooks, reported under `plugins`', async () => {
  setPluginPlaybooksProvider(async () => { throw new Error('host exploded'); });
  const { playbooks, errors } = await loadPlaybooks();
  assert.deepEqual(errors, [{ id: 'plugins', message: 'plugin playbooks unavailable: host exploded' }]);
  for (const id of SEED_PLAYBOOK_IDS) assert.ok(playbooks.has(id), `built-in '${id}' still loads`);
});

test('a plugin graph naming a non-governable tool is rejected by the shared validator', async () => {
  const bad = { ...RELEASE, stages: { ...RELEASE.stages, plan: { tools: { spawn_instance: 'allow', list_projects: 'deny' } } } };
  provide([record('acme', bad)]);
  const { playbooks, errors } = await loadPlaybooks();
  assert.equal(playbooks.has('acme/release'), false);
  assert.ok(errors.some(e => e.id === 'acme/release' && /'list_projects' is not a governable tool/.test(e.message)),
    JSON.stringify(errors));
});

// ── the drift rule, attributed to the plugin ────────────────────────────────

test('a worker bound to a vanished plugin playbook is refused PLAYBOOK_UNKNOWN naming the plugin and the remedy — and governed again once it returns', async () => {
  const live = [{ kind: 'spawn', sessionId: 'w-acme-001', playbook: 'acme/release', stage: 'plan' }];
  const retired = [...live, { kind: 'retire', sessionId: 'w-acme-001' }];
  const decideWith = async (toolName, args, events) => {
    const { playbooks } = await loadPlaybooks();
    return decide({ toolName, args, projection: proj(events), playbooks, isLive: isLiveFromEvents(events) });
  };
  const send = { sessionId: 'w-acme-001', text: 'go', stage: 'plan' };
  const resume = { resume: 'w-acme-001' };

  provide([]);
  for (const [toolName, args, events] of [['send_prompt', send, live], ['spawn_instance', resume, retired]]) {
    const res = await decideWith(toolName, args, events);
    assert.equal(res.ok, false, `${toolName} must be refused`);
    assert.equal(res.code, 'PLAYBOOK_UNKNOWN');
    assert.match(res.reason, /plugin 'acme'/);
    assert.match(res.reason, /re-enabl/);
    assert.doesNotMatch(res.reason, /removed or renamed/, 'the plugin cause replaces the generic one');
  }

  provide([record('acme', RELEASE)]);
  for (const [toolName, args, events] of [['send_prompt', send, live], ['spawn_instance', resume, retired]]) {
    const res = await decideWith(toolName, args, events);
    assert.equal(res.ok, true, `${toolName} on the same projection must succeed once the playbook is back: ${res.reason}`);
  }
});

// The reason builders see only the loaded map, so the same refusal covers a
// failed plugin host — where the plugin is still enabled and "re-enable" alone
// would be the wrong remedy. The text must route to list_playbooks' errors,
// which carries the distinguishing `plugins` entry.
test('with the plugin host failing, the refusal points at the host-unavailable cause and the error that carries it', async () => {
  const events = [{ kind: 'spawn', sessionId: 'w-acme-002', playbook: 'acme/release', stage: 'plan' }];
  setPluginPlaybooksProvider(async () => { throw new Error('init failed'); });
  const { playbooks, errors } = await loadPlaybooks();
  assert.deepEqual(errors.map(e => e.id), ['plugins']);
  const res = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-acme-002', text: 'go', stage: 'plan' },
    projection: proj(events), playbooks, isLive: isLiveFromEvents(events),
  });
  assert.equal(res.code, 'PLAYBOOK_UNKNOWN');
  assert.match(res.reason, /list_playbooks' errors/);
  assert.match(res.reason, /an entry under 'plugins' means the plugin host is unavailable/);
  assert.match(res.reason, /the plugin is disabled \(re-enabling it/,
    're-enable is offered as the remedy for the disabled case only, not asserted');
});

// ── model pins ──────────────────────────────────────────────────────────────

test("a stage pinning its own plugin's role fills it in, and that role resolves while the plugin provides it", async () => {
  provide([record('acme', RELEASE)]);
  setPluginRolesProvider(() => [{ role: 'acme/captain', label: 'Captain', binding: { kind: 'tier', tier: 'powerful' }, plugin: 'acme' }]);
  const { playbooks } = await loadPlaybooks();
  const res = decide({
    toolName: 'spawn_instance', args: { playbook: 'acme/release', stage: 'plan', project: 'demo' },
    projection: proj([]), playbooks, isLive: () => false,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.patchedArgs.model, 'acme/captain');
  assert.equal(isResolvableRole('acme/captain'), true);
});

// ── the preferred playbook ──────────────────────────────────────────────────

test('a preferred plugin playbook renders while loaded, is retained (and reported) while not, and renders again on return', async () => {
  await setSelection(SEED_CONVENTIONS.map(m => m.slug));
  const header = '## Preferred playbook — `acme/release`';

  provide([]);
  await assert.rejects(setDefaultPlaybook({ mode: 'playbook', id: 'acme/release' }),
    e => e.statusCode === 400, 'an unloaded id cannot be chosen');

  provide([record('acme', RELEASE)]);
  await setDefaultPlaybook({ mode: 'playbook', id: 'acme/release' });
  assert.ok((await composeCurrentConduct()).includes(header));
  assert.equal(await defaultPlaybookMissing(), null);

  provide([]);
  assert.ok(!(await composeCurrentConduct()).includes(header), 'an unloaded preferred playbook renders nothing');
  assert.deepEqual(await getDefaultPlaybookSelection(), { mode: 'playbook', id: 'acme/release' },
    'the selection survives the plugin going away');
  const missing = await defaultPlaybookMissing();
  assert.equal(missing?.id, 'acme/release');
  assert.match(missing.reason, /plugin 'acme'/);

  provide([record('acme', RELEASE)]);
  assert.ok((await composeCurrentConduct()).includes(header), 're-providing restores it with no re-selection');
  assert.equal(await defaultPlaybookMissing(), null);
});
