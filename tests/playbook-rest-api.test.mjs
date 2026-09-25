// GET /api/playbooks, GET /api/playbooks/:id and POST /api/playbooks/validate
// (src/playbookApi.ts) — the read + validate contract an authoring plugin
// plans against — plus locateValidationError (src/playbooks.ts), the
// message → stage/edge mapping the validate route attaches.
//
// Booted through buildRoutes (the real mount) with a fake gate, so the ledger
// is never touched; definitions come from this file's own user overlay and a
// plugin record injected through setPluginPlaybooksProvider.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildRoutes } from '../src/routes.ts';
import { orchStoreRoot } from '../src/projects.ts';
import {
  loadToolIndex, governableToolNames, validatePlaybook, locateValidationError, setPluginPlaybooksProvider,
  SEED_PLAYBOOK_IDS, DEFAULT_PLAYBOOK_ID, PIN_FORBIDDEN_KEYS, STAGE_KEYS, NEEDS_KEYS, TRANSITION_KEYS,
} from '../src/playbooks.ts';
import { listPlaybooks } from '../src/mcp/handlers.ts';
import { freshProjectsRoot } from './helpers.mjs';

// `plan` pins/denies/wildcards; `implement` is fully populated (every stage
// key, a defaulted needs entry); `review` is "*"-only (NOT spawnable), and
// reached by an `on` edge that carries no description.
const MINE = {
  id: 'mine', name: 'Mine', description: 'A user playbook.',
  entryStages: ['plan'],
  stages: {
    plan: {
      tools: { spawn_instance: { pin: { model: 'opus' } }, '*': 'allow', kill_instance: 'deny' },
      description: 'Plan it.',
    },
    implement: {
      needs: [{ stage: 'plan' }], workers: 'many', tools: { spawn_instance: 'allow' }, description: 'Build it.',
    },
    review: { tools: { '*': 'allow' } },
  },
  transitions: [
    { from: 'plan', to: 'implement', description: 'Hand off.' },
    { from: 'implement', to: 'review', on: 'set_mode' },
  ],
};

// A valid overlay override of a built-in, and an INVALID one of another.
const OVERRIDDEN = DEFAULT_PLAYBOOK_ID;
const BAD_OVERRIDE = SEED_PLAYBOOK_IDS.find(id => id !== OVERRIDDEN);
const UNTOUCHED = SEED_PLAYBOOK_IDS.find(id => id !== OVERRIDDEN && id !== BAD_OVERRIDE);

const RELEASE = {
  id: 'release', name: 'Acme release', description: 'Plan a release, then ship it.',
  entryStages: ['plan'],
  stages: {
    plan: { tools: { spawn_instance: { pin: { model: 'acme/captain' } } } },
    ship: { needs: [{ stage: 'plan', liveness: 'any' }], tools: { spawn_instance: 'allow' } },
  },
  transitions: [{ from: 'plan', to: 'ship' }],
};

const SUMMARY_KEYS = ['id', 'name', 'description', 'source', 'editable', 'entryStages', 'spawnableStages'];

let overlayDir;
let index;
const servers = [];

async function boot(playbookGate) {
  const app = express();
  app.use('/api', buildRoutes({ instances: { list: () => [] }, playbookGate }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/playbooks`;
  return {
    get: async (p = '') => { const res = await fetch(base + p); return { status: res.status, body: await res.json() }; },
    validate: async (draft) => {
      const res = await fetch(`${base}/validate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

// A projection shaped like PlaybookGate.readProjection's: `mine` has one live
// and one dead worker, the overridden built-in one live worker.
const LIVE = new Set(['s-mine-live', 's-other-live']);
function fakeGate({ fail = false } = {}) {
  const w = (sessionId, playbook) => [sessionId, { sessionId, playbook, stage: 'plan', stageHistory: ['plan'], provenance: {}, runRoot: sessionId }];
  return {
    async readProjection() {
      if (fail) throw new Error('ledger read failed');
      return {
        bySession: new Map([w('s-mine-live', 'mine'), w('s-mine-dead', 'mine'), w('s-other-live', OVERRIDDEN)]),
        enforcement: new Map(), seq: 3, parent: new Map(),
      };
    },
    isLive: sid => LIVE.has(sid),
  };
}

let api; // with the fake gate
let apiNoGate;
let apiFailingGate;

before(async () => {
  await freshProjectsRoot();
  index = await loadToolIndex();
  overlayDir = path.join(orchStoreRoot(), 'playbooks');
  await fs.mkdir(overlayDir, { recursive: true });
  const write = (id, def) => fs.writeFile(path.join(overlayDir, `${id}.json`), JSON.stringify(def));
  await write('mine', MINE);
  await write(OVERRIDDEN, { ...MINE, id: OVERRIDDEN, name: 'User override' });
  await write(BAD_OVERRIDE, { id: BAD_OVERRIDE });
  await write('broken', { id: 'broken', name: 'Broken' });
  await write('custom', { ...MINE, id: 'custom' });
  const { id: _id, ...noId } = MINE;
  await write('noid', noId);
  setPluginPlaybooksProvider(async () => [{ id: 'acme/release', slug: 'release', plugin: 'acme', body: JSON.stringify(RELEASE) }]);
  api = await boot(fakeGate());
  apiNoGate = await boot(null);
  apiFailingGate = await boot(fakeGate({ fail: true }));
});

after(async () => {
  setPluginPlaybooksProvider(null);
  await Promise.all(servers.map(s => new Promise(r => s.close(r))));
});

const row = (body, id) => body.playbooks.find(p => p.id === id);

// ── GET /api/playbooks ──────────────────────────────────────────────────────

test('list: source follows the winning definition — builtin, user, user override, plugin, and a built-in kept past an invalid override', async () => {
  const { status, body } = await api.get();
  assert.equal(status, 200);
  assert.equal(row(body, UNTOUCHED)?.source, 'builtin');
  assert.equal(row(body, 'mine')?.source, 'user');
  assert.equal(row(body, OVERRIDDEN)?.source, 'user');
  assert.equal(row(body, OVERRIDDEN)?.name, 'User override');
  assert.equal(row(body, 'acme/release')?.source, 'plugin:acme');
  assert.equal(row(body, BAD_OVERRIDE)?.source, 'builtin', 'an invalid override leaves the built-in loaded');
  assert.ok(body.errors.some(e => e.id === BAD_OVERRIDE), 'the invalid override is reported under the built-in id');
});

test('list: editable is true exactly on the user rows', async () => {
  const { body } = await api.get();
  assert.ok(body.playbooks.length > 0);
  for (const p of body.playbooks) assert.equal(p.editable, p.source === 'user', `${p.id}: editable ⇔ source==='user'`);
  assert.equal(row(body, 'mine').editable, true);
});

test('list: every entry carries exactly the summary key set', async () => {
  const { body } = await api.get();
  for (const p of body.playbooks) assert.deepEqual(Object.keys(p).sort(), [...SUMMARY_KEYS].sort(), p.id);
});

test('list: errors are list_playbooks\' errors, and include the invalid overlay file', async () => {
  const { body } = await api.get();
  assert.deepEqual(body.errors, (await listPlaybooks()).errors);
  assert.ok(body.errors.some(e => e.id === 'broken'));
});

test('list: an overlay file with no id is refused by the loader as an invalid id', async () => {
  const { body } = await api.get();
  assert.equal(row(body, 'noid'), undefined);
  assert.ok(body.errors.some(e => e.id === 'noid' && /^invalid id 'undefined'/.test(e.message)));
});

test('list: entry and spawnable stages come from the definition; a "*"-only stage is not spawnable', async () => {
  const { body } = await api.get();
  assert.deepEqual(row(body, 'mine').entryStages, ['plan']);
  assert.deepEqual(row(body, 'mine').spawnableStages, ['plan', 'implement']);
});

test('list: governableTools is the validator\'s tool index, pinArgs its pin acceptance set', async () => {
  const { body } = await api.get();
  assert.deepEqual(body.governableTools.map(t => t.name), governableToolNames(index));
  for (const t of body.governableTools) {
    const expected = [...index.get(t.name)].filter(a => !PIN_FORBIDDEN_KEYS.includes(a)).sort();
    assert.deepEqual(t.pinArgs, expected, t.name);
  }
  const spawn = body.governableTools.find(t => t.name === 'spawn_instance');
  for (const k of PIN_FORBIDDEN_KEYS) assert.ok(!spawn.pinArgs.includes(k), `pinArgs must not offer '${k}'`);
  // Bound to the validator itself, not just to the index: every offered pin
  // arg is accepted on spawn_instance, and every forbidden one refused.
  const pinDraft = pin => ({ ...MINE, stages: { ...MINE.stages, plan: { tools: { spawn_instance: { pin } } } } });
  for (const arg of spawn.pinArgs) {
    assert.ok(validatePlaybook(pinDraft({ [arg]: 'x' }), 'mine', index).ok, `pin on '${arg}' is accepted`);
  }
  for (const arg of PIN_FORBIDDEN_KEYS) {
    assert.equal(validatePlaybook(pinDraft({ [arg]: 'x' }), 'mine', index).ok, false, `pin on '${arg}' is refused`);
  }
});

test('list: takenIds — built-ins, every overlay file loaded or not, and the reserved id never a user id', async () => {
  const { body } = await api.get();
  assert.deepEqual(body.takenIds.builtin, [...SEED_PLAYBOOK_IDS].sort());
  for (const id of ['broken', 'mine', OVERRIDDEN, BAD_OVERRIDE]) assert.ok(body.takenIds.user.includes(id), id);
  assert.ok(!body.takenIds.user.includes('custom'));
  assert.deepEqual(body.takenIds.user, [...body.takenIds.user].sort());
  assert.deepEqual(body.takenIds.reserved, ['custom']);
  assert.equal(row(body, 'custom'), undefined, 'a reserved-id file is not loaded');
});

// ── GET /api/playbooks/:id ──────────────────────────────────────────────────

test('detail: the post-validation graph — defaults, policies, spawnable, via, and absent descriptions', async () => {
  const { status, body } = await api.get('/mine');
  assert.equal(status, 200);
  assert.equal(body.id, 'mine');
  assert.equal(body.source, 'user');
  assert.equal(body.editable, true);
  assert.deepEqual(body.entryStages, ['plan']);
  const { plan, implement, review } = body.stages;
  assert.deepEqual(implement.needs, [{ stage: 'plan', position: ['plan'], liveness: 'live' }]);
  assert.equal(plan.workers, 'one');
  assert.equal(implement.workers, 'many');
  assert.deepEqual(plan.tools, MINE.stages.plan.tools);
  assert.deepEqual(review.tools, { '*': 'allow' });
  assert.deepEqual(plan.needs, []);
  assert.equal(plan.spawnable, true);
  assert.equal(review.spawnable, false);
  assert.equal(plan.description, 'Plan it.');
  assert.ok(!('description' in review), 'an unauthored stage description is an absent key');
  assert.deepEqual(body.transitions, [
    { from: 'plan', to: 'implement', via: 'send_prompt', description: 'Hand off.' },
    { from: 'implement', to: 'review', via: 'set_mode' },
  ]);
  assert.ok(!('description' in body.transitions[1]), 'an unauthored transition description is an absent key');
});

test('detail: every schema field reaches the JSON on a fully-populated stage and edge', async () => {
  const { body } = await api.get('/mine');
  const stageKeys = Object.keys(body.stages.implement);
  for (const k of STAGE_KEYS) assert.ok(stageKeys.includes(k), `stage key '${k}'`);
  assert.deepEqual(Object.keys(body.stages.implement.needs[0]).sort(), [...NEEDS_KEYS].sort());
  const edgeKeys = Object.keys(body.transitions[0]);
  for (const k of [...TRANSITION_KEYS].filter(k => k !== 'on').concat('via')) assert.ok(edgeKeys.includes(k), `transition key '${k}'`);
});

test('detail: a plugin id resolves raw and URL-encoded', async () => {
  for (const p of ['/acme/release', '/acme%2Frelease']) {
    const { status, body } = await api.get(p);
    assert.equal(status, 200, p);
    assert.equal(body.id, 'acme/release', p);
    assert.equal(body.source, 'plugin:acme', p);
    assert.equal(body.editable, false, p);
  }
});

test('detail: unknown id, unknown plugin slug and an invalid overlay file are 404 PLAYBOOK_UNKNOWN', async () => {
  for (const id of ['nope', 'acme/nope', 'broken']) {
    const { status, body } = await api.get(`/${id}`);
    assert.equal(status, 404, id);
    assert.deepEqual(body, { error: `no playbook '${id}'`, code: 'PLAYBOOK_UNKNOWN' });
  }
});

test('detail: liveWorkers counts live workers bound to the id; null without a gate or on a failed read (warned once)', async () => {
  assert.equal((await api.get('/mine')).body.liveWorkers, 1);
  assert.equal((await api.get(`/${OVERRIDDEN}`)).body.liveWorkers, 1);
  assert.equal((await api.get(`/${UNTOUCHED}`)).body.liveWorkers, 0);
  assert.equal((await apiNoGate.get('/mine')).body.liveWorkers, null);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const res = await apiFailingGate.get('/mine');
    assert.equal(res.status, 200);
    assert.equal(res.body.liveWorkers, null);
  } finally { console.warn = origWarn; }
  assert.equal(warnings.length, 1);
});

// ── POST /api/playbooks/validate ────────────────────────────────────────────

test('validate: a valid draft answers exactly {ok:true} and writes nothing', async () => {
  const before = (await fs.readdir(overlayDir)).sort();
  const res = await api.validate({ ...MINE, id: 'fresh' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual((await fs.readdir(overlayDir)).sort(), before);
});

test('validate: messages are exactly the validator\'s, in order, each with its located stage/edge', async () => {
  const draft = {
    ...MINE,
    extra: 1,
    stages: { ...MINE.stages, plan: { ...MINE.stages.plan, workers: 'lots' } },
    transitions: [...MINE.transitions, { from: 'plan', to: 'review', description: '' }],
  };
  const expected = validatePlaybook(draft, draft.id, index);
  assert.equal(expected.ok, false);
  assert.ok(expected.errors.length >= 3, 'the fixture exercises several messages');
  const { status, body } = await api.validate(draft);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.deepEqual(body.errors.map(e => e.message), expected.errors);
  assert.deepEqual(body.errors, expected.errors.map(message => ({ message, ...locateValidationError(message, draft) })));
  assert.ok(body.errors.some(e => e.stage === 'plan'));
  assert.ok(body.errors.some(e => e.transition?.from === 'plan' && e.transition?.to === 'review'));
});

test('validate: a tool outside the live governable index is refused', async () => {
  const draft = { ...MINE, stages: { ...MINE.stages, review: { tools: { bogus_tool: 'allow' } } } };
  const { body } = await api.validate(draft);
  assert.equal(body.ok, false);
  assert.ok(body.errors.some(e => e.message.includes("'bogus_tool' is not a governable tool") && e.stage === 'review'));
});

test('validate: a draft with no id reports the slug error once and no filename mismatch', async () => {
  const { id: _id, ...draft } = MINE;
  const { body } = await api.validate(draft);
  assert.equal(body.ok, false);
  assert.ok(!body.errors.some(e => /does not match/.test(e.message)));
  assert.equal(body.errors.filter(e => /invalid id/.test(e.message)).length, 1);
});

test('validate: a non-object JSON body reaches the validator', async () => {
  const { status, body } = await api.validate([]);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.errors.length, 1);
  assert.match(body.errors[0].message, /must be a JSON object/);
  assert.equal(body.errors[0].stage, null);
  assert.equal(body.errors[0].transition, null);
});

// ── locateValidationError ───────────────────────────────────────────────────

// Each case builds a draft, runs the REAL validator, and locates the message
// of the shape under test — so a validator prefix change reddens here.
test('locateValidationError maps each validator message shape', async (t) => {
  const base = () => ({
    id: 'loc', name: 'n', description: 'd', entryStages: ['a'],
    stages: { a: { tools: { spawn_instance: 'allow' } }, b: {} },
    transitions: [{ from: 'a', to: 'b' }],
  });
  const locate = (draft, re) => {
    const res = validatePlaybook(draft, draft.id, index);
    assert.equal(res.ok, false);
    const message = res.errors.find(m => re.test(m));
    assert.ok(message, `no message matching ${re} in ${JSON.stringify(res.errors)}`);
    return locateValidationError(message, draft);
  };
  const atStage = s => ({ stage: s, transition: null });
  const atEdge = (from, to) => ({ stage: null, transition: { from, to } });
  const nowhere = { stage: null, transition: null };

  await t.test("stage 'x': …", () => {
    const d = base(); d.stages.b.bogus = 1;
    assert.deepEqual(locate(d, /^stage 'b': unknown key/), atStage('b'));
  });
  await t.test("stage 'x' must be an object", () => {
    const d = base(); d.stages.c = 5;
    assert.deepEqual(locate(d, /^stage 'c' must be an object/), atStage('c'));
  });
  await t.test("stage 'x' declares spawn_instance …", () => {
    const d = base(); d.stages.b = { tools: { spawn_instance: 'allow' } };
    assert.deepEqual(locate(d, /^stage 'b' declares spawn_instance/), atStage('b'));
  });
  await t.test("stage 'x' is unreachable …", () => {
    const d = base(); d.stages.c = {};
    assert.deepEqual(locate(d, /^stage 'c' is unreachable/), atStage('c'));
  });
  await t.test('transition a->b: …', () => {
    const d = base(); d.transitions[0].description = '';
    assert.deepEqual(locate(d, /^transition a->b: description/), atEdge('a', 'b'));
  });
  await t.test('duplicate transition a->b', () => {
    const d = base(); d.transitions.push({ from: 'a', to: 'b' });
    assert.deepEqual(locate(d, /^duplicate transition a->b$/), atEdge('a', 'b'));
  });
  await t.test('transition from names unknown … → nowhere', () => {
    const d = base(); d.transitions.push({ from: 'zz', to: 'b' });
    assert.deepEqual(locate(d, /^transition from names unknown stage/), nowhere);
  });
  await t.test('entryStages names … → nowhere', () => {
    const d = base(); d.entryStages.push('zz');
    assert.deepEqual(locate(d, /^entryStages names unknown stage/), nowhere);
  });
  await t.test('plan-b is never captured by plan', () => {
    const d = base();
    d.stages = { plan: { tools: { spawn_instance: 'allow' }, bogus: 1 }, 'plan-b': { bogus: 2 } };
    d.entryStages = ['plan'];
    d.transitions = [{ from: 'plan', to: 'plan-b' }];
    assert.deepEqual(locate(d, /^stage 'plan-b': unknown key/), atStage('plan-b'));
    assert.deepEqual(locate(d, /^stage 'plan': unknown key/), atStage('plan'));
  });
});
