// Pins the FLOOR in `DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS = Math.floor(
// DEFAULT_SUBSCRIBE_TIMEOUT_MS / 1000)` (src/idleSubscriptions.ts).
//
// INVARIANT: for every window the MCP schema accepts, arming it must never
// exceed ORCH_SUBSCRIBE_TIMEOUT_MS — i.e. `set_idle_timeout` / `idleTimeoutSeconds`
// can only ever SHORTEN the heartbeat, which is the whole reason the ceiling is
// floored rather than rounded when the ms constant moves into seconds.
//
// Three things make that floor easy to break invisibly; this file defeats all
// three, and its own comments are the record of why it is shaped this way:
//
//   1. OPERATOR COINCIDENCE. At the default 1_800_000, floor == round == ceil
//      == 1800, so no test at the default value can tell the operators apart.
//      Hence the deliberately NON-DIVISIBLE override below: 1_799_500 floors to
//      1799 but rounds AND ceils to 1800.
//   2. TAUTOLOGICAL ASSERTIONS. Comparing the ceiling against the constant that
//      produced it (or against a refusal string that interpolates that same
//      constant) moves both sides together under any operator change. So every
//      expected value here is a HAND-WRITTEN LITERAL — do NOT import
//      DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS into this file to "keep it in sync";
//      the divergence is the point.
//   3. NO BEHAVIOURAL OBSERVATION. A schema number is not the invariant. The
//      last test arms the schema's OWN advertised maximum and asserts the window
//      the hub actually installed is <= the ms ceiling.
//
// Under `round`/`ceil` the ceiling becomes 1800, so `idleTimeoutSeconds: 1800`
// is accepted and arms a 1_800_000ms window — 500ms LONGER than the heartbeat
// it is supposed to be incapable of lengthening.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The constant is computed at module load from the env var, so this must be set
// before src/idleSubscriptions.ts is pulled in — hence the dynamic import of the
// helpers below (same pattern as idle-subagent-defer.test.mjs). 1_799_500 is
// chosen for indivisibility, not for realism.
const CEILING_MS = 1_799_500;
process.env.ORCH_SUBSCRIBE_TIMEOUT_MS = String(CEILING_MS);
// Hand-derived, NOT imported: floor(1799500 / 1000). round/ceil would give 1800.
const TRUE_CEILING_SECONDS = 1799;

const { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf } =
  await import('./helpers.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_OPEN = path.join(__dirname, 'fixtures', 'scenario-open-turn.json');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  instances._idleHub?._owners.clear();
  await rmrf(home);
});

let nextRpcId = 1;
async function rpc(method, params, { caller } = {}) {
  const handle = caller ? (instForSession(instances, caller)?.id ?? caller) : null;
  const url = baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function callTool(name, args, opts) {
  const { body } = await rpc('tools/call', { name, arguments: args }, opts);
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
const unwrap = (r) => JSON.parse(r.content[0].text);
const errText = (r) => r.content.map(c => c.text).join('\n');

async function spawnReady(scenarioPath) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  if (scenarioPath) process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
  try {
    const spawn = unwrap(await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
    return spawn.sessionId;
  } finally { process.env.FAKE_CLAUDE_SCENARIO = prev; }
}

test('the advertised ceiling is the FLOORED second count, not the rounded one', async () => {
  const { body } = await rpc('tools/list');
  const byName = Object.fromEntries(body.result.tools.map(t => [t.name, t.inputSchema.properties]));

  // 1799, not 1800. This is the assertion the operator swap has to get past.
  assert.equal(byName.set_idle_timeout.timeoutSeconds.maximum, TRUE_CEILING_SECONDS,
    'set_idle_timeout must floor the ms ceiling into seconds — rounding up would '
    + 'advertise a window LONGER than ORCH_SUBSCRIBE_TIMEOUT_MS');
  for (const name of ['send_prompt', 'approve_plan', 'reject_plan', 'answer_question']) {
    assert.equal(byName[name].idleTimeoutSeconds.maximum, TRUE_CEILING_SECONDS,
      `${name}.idleTimeoutSeconds must share the same floored ceiling`);
  }
  // …and the floored ceiling is genuinely below the ms one, which is what makes
  // every accepted value fit: 1799 * 1000 <= 1799500.
  assert.ok(TRUE_CEILING_SECONDS * 1000 <= CEILING_MS,
    'the seconds ceiling, re-expressed in ms, must not exceed the ms ceiling');
});

test('the first second ABOVE the floored ceiling is refused, with the floored number in the message', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady();
  const targetId = await spawnReady();

  // 1800 is exactly what round/ceil would have let through. The expected refusal
  // text is written out in full rather than interpolated, so a mutated constant
  // cannot move the assertion along with the behaviour.
  for (const [tool, args] of [
    ['set_idle_timeout', { sessionId: targetId, timeoutSeconds: 1800 }],
    ['send_prompt', { sessionId: targetId, text: 'go', idleTimeoutSeconds: 1800 }],
  ]) {
    const res = await callTool(tool, args, { caller: callerId });
    assert.equal(res.isError, true,
      `${tool} must refuse 1800s — it exceeds the ${CEILING_MS}ms heartbeat ceiling`);
    assert.match(errText(res), /must be <= 1799/);
  }
  // The refusal fired before any handler work, so nothing was armed either.
  assert.equal(instForSession(instances, targetId).status, 'idle');
  assert.deepEqual(instances._idleHub.ownersOf(instForSession(instances, targetId).id), []);
});

test('the LARGEST accepted window arms a heartbeat no longer than the ms ceiling', async () => {
  // The behavioural leg: a schema number is not the invariant. Read the maximum
  // the server itself advertises, arm exactly that, and check the window the hub
  // installed against the ms ceiling — the only comparison that actually says
  // "this can only shorten". Under round/ceil the advertised maximum is 1800,
  // which arms 1_800_000 and fails here even if the refusal above were relaxed.
  const { body } = await rpc('tools/list');
  const advertised = body.result.tools
    .find(t => t.name === 'send_prompt').inputSchema.properties.idleTimeoutSeconds.maximum;

  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady();
  const targetId = await spawnReady(SCENARIO_OPEN); // stays mid-turn, so the arm is observable
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  const res = await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: advertised }, { caller: callerId });
  assert.notEqual(res.isError, true, 'the advertised maximum must itself be accepted');
  await waitFor(() => target.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  const armedMs = instances._idleSubscribers.get(target.id).get(caller.id).timeoutMs;
  assert.equal(armedMs, advertised * 1000, 'seconds at the MCP boundary, ms in the hub');
  assert.ok(armedMs <= CEILING_MS,
    `the largest accepted window armed ${armedMs}ms, above the ${CEILING_MS}ms heartbeat `
    + 'ceiling — "can only shorten" is broken');
});
