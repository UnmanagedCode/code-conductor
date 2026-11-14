// The /api route table's ordering contracts (src/routes.ts, buildRoutes).
// Express 4 dispatches to the first matching layer and these handlers never
// call next() except with an error, so registration order IS behaviour: an
// earlier param route captures a later literal route of the same method, and a
// gate or parser registered after a route never runs for it. Each subtest pins
// one contract against the real router stack (scripts/route-table.mjs); the
// full table is deliberately not a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeLayers, VARIANTS, tableFor } from '../scripts/route-table.mjs';
import { buildRoutes } from '../src/routes.ts';

const SAMPLE = '__p__';
const sampleOf = (p) => p.replace(/:[A-Za-z_]+/g, SAMPLE);
const stackOf = (variant) => buildRoutes(VARIANTS[variant]).stack;
const topLayers = (variant) => routeLayers(stackOf(variant));

// Flat, indexed ROUTE entries of one stack level whose path is a string.
function routesOf(layers) {
  return layers
    .map((e, index) => ({ ...e, index }))
    .filter((e) => e.kind === 'route' && typeof e.path === 'string');
}
const sharesMethod = (a, b) => a.methods.some((m) => b.methods.includes(m));

// [{ name, layers }] for the top level and each sub-router mounted on it.
function levels(variant) {
  const top = topLayers(variant);
  return [{ name: 'top', layers: top }, ...top.filter((e) => e.kind === 'mount').map((e, i) => ({ name: `mount#${i}`, layers: e.children }))];
}

// Pairs (specific route, param twin) of one method: same segment count, and
// wherever they differ the twin has a :param where the specific route has a
// literal segment — so the twin's regexp matches the specific route's path.
function shadowPairs(layers) {
  const rs = routesOf(layers);
  const segs = (p) => p.split('/');
  const out = [];
  for (const lit of rs) {
    for (const par of rs) {
      if (lit === par || !sharesMethod(lit, par)) continue;
      const a = segs(lit.path), b = segs(par.path);
      if (a.length !== b.length) continue;
      const differ = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x !== y);
      if (differ.length > 0 && differ.every(([x, y]) => y.startsWith(':') && !x.startsWith(':'))) out.push({ lit, par });
    }
  }
  return out;
}

const SIX_PAIRS = [
  ['GET', '/projects/:name/commits/uncommitted/diff', '/projects/:name/commits/:sha/diff'],
  ['GET', '/projects/:name/worktrees/:wt/commits/uncommitted/diff', '/projects/:name/worktrees/:wt/commits/:sha/diff'],
  ['PUT', '/settings/conventions/workspace/selection', '/settings/conventions/workspace/:slug'],
  ['PUT', '/settings/conventions/conductor/selection', '/settings/conventions/conductor/:slug'],
  ['PUT', '/settings/conventions/conductor/default-playbook', '/settings/conventions/conductor/:slug'],
  ['PUT', '/settings/conventions/conductor/default-playbook-enforcement', '/settings/conventions/conductor/:slug'],
];

const indexOfParser = (top) => top.findIndex((e) => e.kind === 'use' && e.handlers[0] === 'jsonParser');
const matchesPath = (e, p) => e.layer.regexp.test(p);

test('no route is shadowed by an earlier route of the same method', async (t) => {
  for (const variant of Object.keys(VARIANTS)) {
    for (const { name, layers } of levels(variant)) {
      await t.test(`${variant}/${name}`, () => {
        const rs = routesOf(layers);
        const dead = [];
        for (let i = 0; i < rs.length; i++) {
          for (let j = i + 1; j < rs.length; j++) {
            if (sharesMethod(rs[i], rs[j]) && rs[i].layer.regexp.test(sampleOf(rs[j].path))) {
              dead.push(`${rs[i].methods} ${rs[i].path} captures later ${rs[j].path}`);
            }
          }
        }
        assert.deepEqual(dead, []);
      });
    }
  }
});

test('the six literal/param twins register the literal first', async (t) => {
  const pairs = shadowPairs(topLayers('present'));
  for (const [method, lit, par] of SIX_PAIRS) {
    await t.test(`${method} ${lit}`, () => {
      const hit = pairs.find((p) => p.lit.path === lit && p.par.path === par && p.lit.methods.includes(method));
      assert.ok(hit, 'the generic scan finds the pair');
      assert.ok(hit.lit.index < hit.par.index, 'literal registered before its param twin');
    });
  }
});

test('Cache-Control is the first layer, ahead of the body parser', () => {
  const top = topLayers('present');
  assert.equal(top[0].kind, 'use');
  assert.ok(top[0].layer.regexp.fast_slash, 'mounted at /');
  assert.equal(top[0].arity, 3);
  assert.equal(top[0].handlers[0], '<anon>');
  assert.ok(0 < indexOfParser(top));
});

test('POST /exec carries its own parser and precedes the router-wide one', () => {
  const top = topLayers('present');
  const exec = routesOf(top).find((r) => r.path === '/exec' && r.methods.includes('POST'));
  assert.ok(exec, 'POST /exec registered');
  assert.deepEqual(exec.handlers, ['jsonParser', '<anon>']);
  const parser = indexOfParser(top);
  assert.ok(parser >= 0 && exec.index < parser);
});

test('each capability gate precedes every route it covers', async (t) => {
  const gates = [
    ['remoteSystems', '/settings/systems', [['GET', '/settings/systems'], ['PUT', '/projects/:name/remote']]],
    ['voice', '/tts', [['POST', '/tts'], ['POST', '/transcribe']]],
  ];
  const top = topLayers('present');
  const rs = routesOf(top);
  for (const [name, probe, controls] of gates) {
    await t.test(name, () => {
      const gateAt = top.findIndex((e) => e.kind === 'use' && !e.layer.regexp.fast_slash && matchesPath(e, probe));
      assert.ok(gateAt >= 0, 'a gate layer covers the probe path');
      const gate = top[gateAt];
      const covered = rs.filter((r) => matchesPath(gate, sampleOf(r.path)));
      for (const [method, p] of controls) {
        assert.ok(covered.some((r) => r.path === p && r.methods.includes(method)), `${method} ${p} is covered`);
      }
      assert.ok(covered.length > 0);
      assert.deepEqual(covered.filter((r) => r.index < gateAt).map((r) => r.path), []);
    });
  }
});

test('/plugins and /playbooks mount after the JSON parser', () => {
  const top = topLayers('present');
  const parser = indexOfParser(top);
  for (const p of ['/plugins', '/playbooks']) {
    const at = top.findIndex((e) => e.kind === 'mount' && matchesPath(e, p));
    assert.ok(at > parser && parser >= 0, `${p} mounted after the parser`);
  }
});

test('the one error handler is the last top-level layer', () => {
  for (const variant of Object.keys(VARIANTS)) {
    const top = topLayers(variant);
    const last = top[top.length - 1];
    assert.equal(last.kind, 'use');
    assert.equal(last.arity, 4);
    const arity4 = [];
    const walk = (ls) => { for (const e of ls) { if (e.kind === 'mount') walk(e.children); else if (e.kind === 'use' && e.arity === 4) arity4.push(e); } };
    walk(top);
    assert.equal(arity4.length, 1, `${variant}: exactly one arity-4 layer`);
  }
});

test('the instances gate covers exactly the instance routes, in place', () => {
  const present = tableFor('present').split('\n');
  const absent = tableFor('absent').split('\n');
  let at = 0;
  for (const line of absent) {
    const found = present.indexOf(line, at);
    assert.ok(found >= 0, `absent line kept in order: ${line}`);
    at = found + 1;
  }
  const kept = new Set(absent);
  const extra = present.filter((l) => !kept.has(l));
  assert.ok(extra.length > 0);
  for (const l of extra) {
    assert.match(l, /^ROUTE \S+ (\/instances|\/sessions\/:sessionId\/pristine)/, 'only instance routes are gated');
  }
  assert.ok(present.some((l) => l.startsWith('ROUTE GET /instances ')));
});
