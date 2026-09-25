// Pure derivations behind the sidebar's Missions lens and ownership colour
// (public/missions.js, public/conductorColor.js). No DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const M = await import(pathToFileURL(path.join(PUB, 'missions.js')).href);
const { conductorColor } = await import(pathToFileURL(path.join(PUB, 'conductorColor.js')).href);

const HSL = /^hsl\((\d+) (\d+)% (\d+)%\)$/;

test('conductorColor is deterministic and lands on one of 12 hue slots', () => {
  const ids = ['a', 'sid-1', '0d9f8c2e-1111-4222-8333-444455556666', 'zzzzzzzz'];
  const sl = new Set();
  for (const id of ids) {
    const c = conductorColor(id);
    assert.equal(conductorColor(id), c, 'same id → same colour');
    const m = HSL.exec(c);
    assert.ok(m, `hsl() form: ${c}`);
    const hue = Number(m[1]);
    assert.ok(hue % 30 === 0 && hue >= 0 && hue <= 330, `hue ${hue} is a 30° slot`);
    sl.add(`${m[2]}/${m[3]}`);
  }
  assert.equal(sl.size, 1, 'saturation and lightness are fixed across ids');
});

test('conductorColor reaches every slot', () => {
  const hues = new Set();
  for (let i = 0; i < 500; i++) hues.add(HSL.exec(conductorColor(`session-${i}`))[1]);
  assert.equal(hues.size, 12);
});

const inst = (o) => ({ project: 'p', worktree: null, status: 'idle', ownerSessionId: null, ...o });

test('deriveMissions splits live from inactive by instance status', () => {
  const { live, inactive } = M.deriveMissions({
    conductRows: [{ sessionId: 'disk', lastActivity: 5 }],
    instances: [
      inst({ id: 'i1', project: '.conduct', sessionId: 'live', status: 'turn', createdAt: 1 }),
      inst({ id: 'i2', project: '.conduct', sessionId: 'ex', status: 'exited', createdAt: 2 }),
      inst({ id: 'i3', project: '.conduct', sessionId: 'cr', status: 'crashed', createdAt: 3 }),
      inst({ id: 'i4', project: 'other', sessionId: 'notconduct' }),
    ],
  });
  assert.deepEqual(live.map(c => c.sessionId), ['live']);
  assert.deepEqual(new Set(inactive.map(c => c.sessionId)), new Set(['disk', 'ex', 'cr']));
  assert.equal(inactive.find(c => c.sessionId === 'ex').instanceId, 'i2', 'a dead conductor keeps its instanceId');
  assert.equal(inactive.find(c => c.sessionId === 'disk').instanceId, null);
});

// A temp conductor is archived on exit; it is still an inactive conductor.
test('archived conduct rows land in inactive, ordered by activity with the rest', () => {
  const { live, inactive } = M.deriveMissions({
    conductRows: [
      { sessionId: 'arch-new', archived: true, lastActivity: 90 },
      { sessionId: 'plain', lastActivity: 50 },
      { sessionId: 'arch-old', archived: true, lastActivity: 10 },
    ],
    instances: [],
  });
  assert.equal(live.length, 0);
  assert.deepEqual(inactive.map(c => c.sessionId), ['arch-new', 'plain', 'arch-old']);
});

test('both groups order newest activity first', () => {
  const { live, inactive } = M.deriveMissions({
    conductRows: [
      { sessionId: 'L1', lastActivity: 100 },
      { sessionId: 'L2', lastActivity: 10 },
      { sessionId: 'D1', lastActivity: 50 },
      { sessionId: 'D2', lastActivity: 70 },
    ],
    instances: [
      // disk activity 100 beats the instance's createdAt 20
      inst({ id: 'a', project: '.conduct', sessionId: 'L1', createdAt: 20 }),
      // lastResponseAt 300 beats disk activity 10
      inst({ id: 'b', project: '.conduct', sessionId: 'L2', createdAt: 5, lastResponseAt: 300 }),
      inst({ id: 'c', project: '.conduct', sessionId: 'L3', createdAt: 200 }),
      inst({ id: 'd', project: '.conduct', sessionId: 'D3', status: 'exited', createdAt: 60 }),
    ],
  });
  assert.deepEqual(live.map(c => c.sessionId), ['L2', 'L3', 'L1']);
  assert.deepEqual(inactive.map(c => c.sessionId), ['D2', 'D3', 'D1']);
});

// A conductor's activity is the LATER of its disk row and its live instance
// (lastResponseAt ?? createdAt). Each case is built so the max, and only the
// max, decides the order against a single-source neighbour.
test('a conductor\'s activity is the later of its disk row and its instance — whichever side is later decides the order', async (t) => {
  await t.test('disk activity is the later one', () => {
    const { live } = M.deriveMissions({
      conductRows: [{ sessionId: 'X', lastActivity: 500 }],
      instances: [
        inst({ id: 'x', project: '.conduct', sessionId: 'X', createdAt: 100 }), // instance alone: 100
        inst({ id: 'y', project: '.conduct', sessionId: 'Y', createdAt: 300 }),
      ],
    });
    assert.deepEqual(live.map(c => c.sessionId), ['X', 'Y'], 'X ranks by its disk 500, not its instance 100');
    assert.equal(live[0].lastActivity, 500);
  });
  await t.test('instance activity is the later one', () => {
    const { live } = M.deriveMissions({
      conductRows: [{ sessionId: 'Z', lastActivity: 100 }],                      // disk alone: 100
      instances: [
        inst({ id: 'z', project: '.conduct', sessionId: 'Z', createdAt: 50, lastResponseAt: 600 }),
        inst({ id: 'w', project: '.conduct', sessionId: 'W', createdAt: 400 }),
      ],
    });
    assert.deepEqual(live.map(c => c.sessionId), ['Z', 'W'], 'Z ranks by its instance 600, not its disk 100');
    assert.equal(live[0].lastActivity, 600);
  });
});

test('missionTitle prefers the title, falls back to the first prompt flagged untitled, then the sid prefix', () => {
  assert.deepEqual(M.missionTitle({ sessionId: 'abcdefghij', title: '  Ship it ', firstPrompt: 'x' }), { text: 'Ship it', untitled: false });
  assert.deepEqual(M.missionTitle({ sessionId: 'abcdefghij', title: '  ', firstPrompt: 'do\n  the\tthing' }), { text: 'do the thing', untitled: true });
  assert.equal(M.missionTitle({ sessionId: 's', firstPrompt: 'y'.repeat(200) }).text.length, 80);
  assert.deepEqual(M.missionTitle({ sessionId: 'abcdefghij' }), { text: 'abcdefgh…', untitled: true });
});

test('workersOf counts only live instances owned by that conductor', () => {
  const instances = [
    inst({ id: 'w1', sessionId: 'w1', ownerSessionId: 'A' }),
    inst({ id: 'w2', sessionId: 'w2', ownerSessionId: 'A', project: 'q' }), // nested worker: same root owner
    inst({ id: 'h', sessionId: 'h', ownerSessionId: null }),                 // hand-spawned
    inst({ id: 'd', sessionId: 'd', ownerSessionId: null, status: 'exited', conducted: true }), // dead
    inst({ id: 'b', sessionId: 'b', ownerSessionId: 'B' }),                  // another conductor
  ];
  assert.deepEqual(M.workersOf('A', instances).map(i => i.id), ['w1', 'w2']);
});

test('missionProjects is the sorted distinct projects of live owned workers', () => {
  assert.deepEqual(M.missionProjects([
    inst({ project: 'zeta' }), inst({ project: 'alpha' }), inst({ project: 'zeta' }),
  ]), ['alpha', 'zeta']);
  assert.deepEqual(M.missionProjects([]), []);
});

test('worktreeOwnership is none / single / mixed over all owners in the place', () => {
  const owners = M.ownersByPlace([
    inst({ project: 'p', worktree: { worktreeName: 'solo' }, ownerSessionId: 'A' }),
    inst({ project: 'p', worktree: { worktreeName: 'solo' }, ownerSessionId: 'A' }),
    inst({ project: 'p', worktree: { worktreeName: 'solo' }, ownerSessionId: null }),
    inst({ project: 'p', worktree: { worktreeName: 'mix' }, ownerSessionId: 'A' }),
    inst({ project: 'p', worktree: { worktreeName: 'mix' }, ownerSessionId: 'B' }),
    inst({ project: 'p', worktree: { worktreeName: 'hand' }, ownerSessionId: null }),
    inst({ project: 'p', ownerSessionId: 'C' }),
  ]);
  assert.deepEqual(M.worktreeOwnership(owners.get('p:solo')), { kind: 'single', owner: 'A' });
  assert.deepEqual(M.worktreeOwnership(owners.get('p:mix')), { kind: 'mixed' });
  assert.deepEqual(M.worktreeOwnership(owners.get('p:hand')), { kind: 'none' });
  assert.deepEqual([...owners.get('p')], ['C'], 'the main checkout is keyed by the bare project');
});

test('stageText is verbatim and opaque', () => {
  assert.equal(M.stageText({ playbook: 'triage-lab', stage: 'write-it-up ✎' }), 'triage-lab · write-it-up ✎');
  assert.equal(M.stageText({ playbook: 'forge', stage: null }), 'forge');
  assert.equal(M.stageText({ playbook: null, stage: null }), null);
  assert.equal(M.stageText({}), null);
});

test('ownerLabel prefers a mission title, then a live instance label, then the sid prefix', () => {
  const missions = { live: [{ sessionId: 'A', title: 'Alpha' }], inactive: [] };
  const instances = [inst({ sessionId: 'H', firstPrompt: 'hand  owner' })];
  assert.equal(M.ownerLabel('A', { missions, instances }), 'Alpha');
  assert.equal(M.ownerLabel('H', { missions, instances }), 'hand owner');
  assert.equal(M.ownerLabel('abcdefghijk', { missions, instances }), 'abcdefgh…');
});

test('deriveMissions carries awaitingUser and awaitingUserSource from the live instance', () => {
  const { live } = M.deriveMissions({
    conductRows: [{ sessionId: 'A', lastActivity: 1 }],
    instances: [
      { id: 'iA', project: '.conduct', sessionId: 'A', status: 'idle', awaitingUser: 'plan', awaitingUserSource: 'tool' },
      { id: 'iB', project: '.conduct', sessionId: 'B', status: 'turn', awaitingUser: 'question', awaitingUserSource: 'text' },
      { id: 'iC', project: '.conduct', sessionId: 'C', status: 'idle' },
    ],
  });
  const by = new Map(live.map(c => [c.sessionId, c]));
  assert.equal(by.get('A').awaitingUser, 'plan');
  assert.equal(by.get('A').awaitingUserSource, 'tool');
  assert.equal(by.get('B').awaitingUser, 'question');
  assert.equal(by.get('B').awaitingUserSource, 'text');
  assert.equal(by.get('C').awaitingUser, null);
  assert.equal(by.get('C').awaitingUserSource, null);
});

test('a disk-only mission row has null awaitingUser even when its disk row reports one', () => {
  const { inactive } = M.deriveMissions({
    conductRows: [{ sessionId: 'D', lastActivity: 1, awaitingUser: 'question', awaitingUserSource: 'tool' }],
  });
  assert.equal(inactive[0].awaitingUser, null);
  assert.equal(inactive[0].awaitingUserSource, null);
});
