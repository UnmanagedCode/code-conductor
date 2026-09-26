// Integration tests for the overhauled MCP I/O contract:
//   - validateArgs constraint enforcement (pattern / min-max / length / array items)
//   - unknown-property rejection (incl. dropped legacy aliases)
//   - the multi-block output format (metadata block + raw text body blocks)
//   - ok/refusal normalization with stable codes
//   - error statusCode/code surfacing
//   - tools/list annotations
// Drives the /mcp transport via fetch, same shape a real MCP client would use.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, driveTurn, registerLocalProject} from './helpers.mjs';
import { DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS } from '../src/idleSubscriptions.ts';
import { MCP_RESULT_CHAR_BUDGET } from '../src/mcp/content.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_INSTANCE = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function rpc(method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  return { status: res.status, body: await res.json() };
}
async function callTool(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
// content[0] is always the compact JSON metadata block.
function meta(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
// content[1..] are the raw, un-escaped text body block(s).
function bodies(result) { return result.content.slice(1).map(c => c.text); }
// A plain-text tool's whole result: one text block, no metadata block.
function text(result) {
  assert.equal(result.content.length, 1, 'a rendered read result is a single block');
  return result.content[0].text;
}
function errText(result) { return result.content.map(c => c.text).join('\n'); }

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}
async function makeRealRepo(name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await registerLocalProject(name, repoPath);
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

// ---------- validateArgs constraint enforcement ----------

test('validateArgs enforces pattern (create_project name)', async () => {
  const { body } = await rpc('tools/call', {
    name: 'create_project', arguments: { name: 'bad name with spaces' },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /must match \^\[a-zA-Z0-9/);
});

test('validateArgs enforces minLength/maxLength (create_workspace name)', async () => {
  const short = await rpc('tools/call', { name: 'create_workspace', arguments: { name: '' } });
  assert.equal(short.body.result.isError, true);
  assert.match(short.body.result.content[0].text, /at least 1 character/);
  const long = await rpc('tools/call', { name: 'create_workspace', arguments: { name: 'x'.repeat(41) } });
  assert.equal(long.body.result.isError, true);
  assert.match(long.body.result.content[0].text, /at most 40 character/);
});

test('validateArgs enforces minimum/maximum (project_diff contextLines, get_recent_messages count)', async () => {
  const hi = await rpc('tools/call', {
    name: 'project_diff', arguments: { project: 'x', worktree: 'y', contextLines: 99 },
  });
  assert.equal(hi.body.result.isError, true);
  assert.match(hi.body.result.content[0].text, /<= 50/);

  const lo = await rpc('tools/call', { name: 'get_recent_messages', arguments: { sessionId: 'x', count: 0 } });
  assert.equal(lo.body.result.isError, true);
  assert.match(lo.body.result.content[0].text, />= 1/);

  const big = await rpc('tools/call', { name: 'get_recent_messages', arguments: { sessionId: 'x', count: 99 } });
  assert.equal(big.body.result.isError, true);
  assert.match(big.body.result.content[0].text, /<= 50/);
});

test('validateArgs enforces array items.type (project_diff paths)', async () => {
  const { body } = await rpc('tools/call', {
    name: 'project_diff', arguments: { project: 'x', worktree: 'y', paths: ['ok', 7] },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /paths\[1\]' must be string/);
});

// ---------- unknown-property rejection (clean break: aliases gone) ----------

test('unknown property is rejected with an actionable message', async () => {
  const { body } = await rpc('tools/call', {
    name: 'list_sessions', arguments: { project: 'a', bogus: 1 },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /unexpected argument 'bogus'/);
  assert.match(body.result.content[0].text, /Allowed: project, worktree/);
});

test('dropped legacy aliases (instanceId / worktreeName) are rejected as unknown', async () => {
  const a = await rpc('tools/call', {
    name: 'approve_plan', arguments: { sessionId: 'x', instanceId: 'x' },
  });
  assert.equal(a.body.result.isError, true);
  assert.match(a.body.result.content[0].text, /unexpected argument 'instanceId'/);

  const w = await rpc('tools/call', {
    name: 'project_diff', arguments: { project: 'p', worktree: 'w', worktreeName: 'w' },
  });
  assert.equal(w.body.result.isError, true);
  assert.match(w.body.result.content[0].text, /unexpected argument 'worktreeName'/);
});

test('spawn_instance rejects a temp argument as unknown (no MCP knob for it)', async () => {
  const { body } = await rpc('tools/call', {
    name: 'spawn_instance', arguments: { project: 'a', temp: true },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /unexpected argument 'temp'/);
});

test('send_prompt no longer accepts wait — refused as an unknown argument, and no turn starts', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const spawn = meta(await callTool('spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
  const inst = instForSession(instances, spawn.sessionId);
  const before = inst.ringSnapshot().length;

  const { body } = await rpc('tools/call', {
    name: 'send_prompt',
    arguments: { sessionId: spawn.sessionId, text: 'go', wait: true },
  });
  const rendered = JSON.stringify(body);
  assert.match(rendered, /unexpected argument 'wait'/);
  assert.match(rendered, /Allowed:.*idleTimeoutSeconds/, 'the refusal names the surviving parameter set');

  // The refusal fires before any handler work: no turn, no echo.
  await new Promise(r => setTimeout(r, 100));
  assert.equal(inst.status, 'idle', 'the worker never started a turn');
  assert.ok(!inst.ringSnapshot().slice(before).some(e => e.kind === 'user_echo'),
    'nothing was sent to the worker');
});

test('spawn_instance schema does not advertise a temp property', async () => {
  const { body } = await rpc('tools/list');
  const tool = body.result.tools.find(t => t.name === 'spawn_instance');
  assert.ok(tool, 'tools/list missing spawn_instance');
  assert.ok(!('temp' in tool.inputSchema.properties), 'spawn_instance schema must not advertise temp');
});

test('legacy {id} worker handle is rejected (clean break — sessionId only)', async () => {
  // The pure-legacy shape {id} fails the now-required sessionId.
  const legacy = await rpc('tools/call', {
    name: 'kill_instance', arguments: { id: 'x' },
  });
  assert.equal(legacy.body.result.isError, true);
  assert.match(legacy.body.result.content[0].text, /missing required argument: sessionId/);

  // And `id` alongside sessionId is explicitly rejected as unexpected — there
  // is no accept-both shim.
  for (const name of ['send_prompt', 'get_recent_messages', 'kill_instance', 'set_mode']) {
    const r = await rpc('tools/call', {
      name, arguments: { sessionId: 'x', id: 'x', text: 'hi', mode: 'plan' },
    });
    assert.equal(r.body.result.isError, true, `${name} should reject legacy {id}`);
    assert.match(r.body.result.content[0].text, /unexpected argument 'id'/,
      `${name} should name 'id' as unexpected`);
  }
});

// ---------- multi-block output ----------

test('project_read returns a metadata block + a raw UNESCAPED text body block', async () => {
  const repoPath = await makeRealRepo('demo');
  const raw = 'line1\n"quoted" line\nline3\n';
  await fs.writeFile(path.join(repoPath, 'multi.txt'), raw);

  const res = await callTool('project_read', { project: 'demo', relativePath: 'multi.txt' });
  assert.equal(res.content.length, 2, 'metadata block + one body block');
  const m = meta(res);
  assert.equal(m.encoding, 'utf8');
  assert.equal(m.lineCount, 3);
  assert.equal(m.lineCountExact, true);
  assert.equal(m.truncated, false);
  assert.equal(m.content, undefined, 'body is NOT inlined into the metadata block');
  // The body block carries the literal bytes — no JSON escaping.
  assert.equal(bodies(res)[0], raw);
});

test('project_read truncated fast path reports lineCountExact:false', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'big.txt'), 'abcdefghij\n'.repeat(100));
  const res = await callTool('project_read', { project: 'demo', relativePath: 'big.txt', maxBytes: 25 });
  const m = meta(res);
  assert.equal(m.truncated, true);
  assert.equal(m.lineCountExact, false, 'partial final line on the byte-capped fast path');
});

test('project_read binary returns a base64 body block', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'b.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const res = await callTool('project_read', { project: 'demo', relativePath: 'b.bin' });
  const m = meta(res);
  assert.equal(m.encoding, 'base64');
  assert.equal(bodies(res)[0], Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('base64'));
});

test('project_diff diff mode → 2 blocks, head is a SHA, no sizeBytes; summary → 1 block', async () => {
  await makeRealRepo('demo');
  const wt = meta(await callTool('create_worktree', { project: 'demo' }));
  const wtPath = wt.worktreePath;
  await fs.writeFile(path.join(wtPath, 'new.txt'), 'fresh\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add new.txt');

  const diff = await callTool('project_diff', { project: 'demo', worktree: wt.worktree });
  assert.equal(diff.content.length, 2);
  const dm = meta(diff);
  assert.match(dm.head, /^[0-9a-f]{40}$/);
  assert.equal(dm.sizeBytes, undefined);
  assert.equal(dm.worktreeName, undefined);
  assert.equal(dm.worktree, wt.worktree);
  assert.match(bodies(diff)[0], /\+fresh/);

  const summary = await callTool('project_diff', { project: 'demo', worktree: wt.worktree, summary: true });
  assert.equal(summary.content.length, 1, 'summary mode is a single JSON block');
  const sm = meta(summary);
  assert.equal(sm.summary, true);
  assert.match(sm.head, /^[0-9a-f]{40}$/);
});

test('get_recent_messages → metadata + one raw body block per message (block k+1 ↔ messages[k])', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const spawn = meta(await callTool('spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');

  // Empty → just the metadata block, no body blocks.
  const empty = await callTool('get_recent_messages', { sessionId: spawn.sessionId });
  assert.equal(empty.content.length, 1);
  assert.deepEqual(meta(empty).messages, []);

  await driveTurn(instances, spawn.sessionId, () => callTool('send_prompt', { sessionId: spawn.sessionId, text: 'one' }));
  await driveTurn(instances, spawn.sessionId, () => callTool('send_prompt', { sessionId: spawn.sessionId, text: 'two' }));

  const res = await callTool('get_recent_messages', { sessionId: spawn.sessionId, count: 2 });
  const m = meta(res);
  assert.equal(m.messages.length, 2);
  // One raw body per message, in order.
  assert.equal(res.content.length, 3); // meta + 2 bodies
  const b = bodies(res);
  // >1 message returned: each body is prefixed with a boundary line so
  // consecutive raw text blocks (content[k+1]) never visually run together.
  assert.equal(b[0], `--- message 1/2 · ${m.messages[0].msgId} · ${m.messages[0].textChars} chars ---\nFirst `);
  assert.equal(b[1], `--- message 2/2 · ${m.messages[1].msgId} · ${m.messages[1].textChars} chars ---\nSecond!`);
  // Metadata carries char counts + flags, not the prose itself, and is
  // unaffected by the boundary line — textChars is the raw prose length.
  assert.equal(m.messages[0].textChars, 'First '.length);
  assert.equal(m.messages[0].textTruncated, false);
  assert.equal(m.messages[0].text, undefined);
  assert.equal(m.messages[0].index, 0);

  // A single-message result stays byte-identical to before — no boundary line.
  const single = await callTool('get_recent_messages', { sessionId: spawn.sessionId, count: 1 });
  assert.equal(bodies(single)[0], 'Second!');
});

// ---------- ok / refusal normalization ----------

test('acknowledgement tools no longer carry a constant ok:true', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const spawn = meta(await callTool('spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  await waitFor(() => instForSession(instances, spawn.sessionId));

  const sent = meta(await callTool('send_prompt', { sessionId: spawn.sessionId, text: 'go' }));
  assert.equal(sent.ok, undefined);
  assert.equal(sent.sessionId, spawn.sessionId);

  const ws = meta(await callTool('create_workspace', { name: 'WS' }));
  assert.equal(ws.ok, undefined);
  assert.equal(ws.added, true);

  const killed = meta(await callTool('kill_instance', { sessionId: spawn.sessionId }));
  assert.equal(killed.ok, undefined);
  assert.equal(killed.sessionId, spawn.sessionId);
});

test('delete_worktree soft-refuses (ok:false + code) on dirty and attached, never throws', async () => {
  // Needs scenario-instance: spawn_instance resolves immediately to idle (scenario-ws
  // waits for a send_prompt before producing output).
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await makeRealRepo('demo');

    // Attached: live instance in a fresh worktree.
    const spawn = meta(await callTool('spawn_instance', {
      project: 'demo', mode: 'bypassPermissions', createWorktree: true,
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId)?.worktree);
    const wtName = instForSession(instances, spawn.sessionId).worktree.worktreeName;

    const attached = meta(await callTool('delete_worktree', { project: 'demo', worktree: wtName }));
    assert.equal(attached.ok, false);
    assert.equal(attached.code, 'WORKTREE_ATTACHED');

    await callTool('kill_instance', { sessionId: spawn.sessionId });

    // Dirty: uncommitted change in the worktree.
    await fs.writeFile(path.join(projectsRoot, '.worktrees', 'demo', wtName, 'dirty.txt'), 'uncommitted\n');
    const dirty = meta(await callTool('delete_worktree', { project: 'demo', worktree: wtName }));
    assert.equal(dirty.ok, false);
    assert.equal(dirty.code, 'WORKTREE_DIRTY');

    // force:true succeeds and returns bare data (no ok).
    const done = meta(await callTool('delete_worktree', { project: 'demo', worktree: wtName, force: true }));
    assert.equal(done.ok, undefined);
    assert.equal(done.worktree, wtName);
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

// ---------- error statusCode / code surfacing ----------

test('errors surface prose (HTTP <code>) plus a structured {code, statusCode} block', async () => {
  await makeRealRepo('demo');
  const { body } = await rpc('tools/call', {
    name: 'project_read', arguments: { project: 'demo', relativePath: 'nope.txt' },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /file not found.*\(HTTP 404\)/);
  const structured = JSON.parse(body.result.content[1].text);
  assert.equal(structured.statusCode, 404);
  assert.equal(structured.code, 'NOT_FOUND');
});

test('project_diff invalid baseRef surfaces statusCode 400', async () => {
  await makeRealRepo('demo');
  const wt = meta(await callTool('create_worktree', { project: 'demo' }));
  const { body } = await rpc('tools/call', {
    name: 'project_diff', arguments: { project: 'demo', worktree: wt.worktree, baseRef: '--evil' },
  });
  assert.equal(body.result.isError, true);
  assert.match(errText(body.result), /\(HTTP 400\)/);
  assert.equal(JSON.parse(body.result.content[1].text).statusCode, 400);
});

// ---------- project_status dirty cap ----------

test('project_status caps the dirty list with dirtyTruncated + dirtyTotal', async () => {
  const repoPath = await makeRealRepo('demo');
  await Promise.all(Array.from({ length: 520 }, (_, i) =>
    fs.writeFile(path.join(repoPath, `f${i}.txt`), 'x\n')));
  const st = text(await callTool('project_status', { project: 'demo' }));
  // The cap must never read as "only 500 files changed" — both counts, and the
  // word truncated, are on the section header.
  const header = st.split('\n').find(l => l.startsWith('DIRTY '));
  const m = /^DIRTY \((\d+) of (\d+) — truncated\)$/.exec(header ?? '');
  assert.ok(m, `expected a truncated DIRTY header, got: ${header}`);
  assert.equal(Number(m[1]), 500);
  assert.ok(Number(m[2]) >= 520);
  assert.equal(st.split('\n').filter(l => /^ {2}\?\? f\d+\.txt$/.test(l)).length, 500,
    'exactly the capped number of porcelain lines is rendered');
});

// ---------- text-only results ----------
//
// Each of these returns a plain-text rendering as its ENTIRE result — no
// metadata block, no structured channel. The renderings themselves are pinned in
// tests/mcp-text-render.test.mjs; this checks the wire shape and that real
// handler output actually reaches the renderer.
//
// describe_playbook is here for its SUCCESS path only; its refusal is still a
// JSON `{ok:false, code}` (pinned in tests/playbook-read-tools.test.mjs).

// One entry per plain-text tool, plus list_sessions twice — its filtered and
// unfiltered forms render different headings.
const RENDERED_TOOLS = [
  { name: 'list_projects', args: {}, head: /^PROJECTS \(/ },
  { name: 'list_sessions', args: {}, head: /^SESSIONS \(/ },
  { name: 'list_worktrees', args: { project: 'demo' }, head: /^WORKTREES \(/ },
  { name: 'list_sessions', args: { project: 'demo' }, head: /^SESSIONS \(/ },
  { name: 'project_status', args: { project: 'demo' }, head: /^demo$/m },
  // Loads from playbooks/*.json, so it needs no repo fixture.
  { name: 'describe_playbook', args: { id: 'solo' }, head: /^PLAYBOOK solo$/m },
  // Needs a session to describe, so its args are resolved inside the test from
  // the worker spawned there.
  { name: 'describe_session', args: env => ({ sessionId: env.sessionId }), head: /^SESSION \S+ {3}live$/m },
];

test('every plain-text tool returns one text block and nothing else', async () => {
  await makeRealRepo('demo');
  const spawn = meta(await callTool('spawn_instance', { project: 'demo', mode: 'bypassPermissions' }));
  await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
  const env = { sessionId: spawn.sessionId };
  for (const { name, args: argSpec, head } of RENDERED_TOOLS) {
    const args = typeof argSpec === 'function' ? argSpec(env) : argSpec;
    const r = await callTool(name, args);
    assert.equal(r.content.length, 1, `${name}: one block, no metadata block`);
    assert.equal(r.content[0].type, 'text');
    assert.match(r.content[0].text, head, `${name}: renders its own heading`);
    assert.equal(r.structuredContent, undefined,
      `${name}: the structured channel was removed — text is the only output`);
  }
});

test('a real worktree reaches the rendering with its branch, base and paths', async () => {
  // Guards the handler→renderer wiring against live data: the pure tests feed
  // hand-built rows, so only this notices a payload the renderer mis-reads.
  const repoPath = await makeRealRepo('demo');
  const created = JSON.parse((await callTool('create_worktree', { project: 'demo' })).content[0].text);
  const wtName = created.worktree ?? created.worktreeName;
  assert.ok(wtName, `create_worktree returned no name: ${JSON.stringify(created)}`);

  const wts = text(await callTool('list_worktrees', { project: 'demo' }));
  assert.ok(wts.includes(wtName), 'the worktree name is in the rendering');
  assert.ok(wts.includes('— demo'), 'the header carries the parent project');
  // parentPath is deliberately absent: it is not row-invariant once a worktree
  // can be based on another (see tests/worktree-feature-branch.test.mjs T11).
  assert.ok(!wts.split('\n')[0].includes(repoPath), 'the header must not hoist a row parentPath');
  assert.match(wts, /br \S+ {2}base \S+@[0-9a-f]{12} {2}created /);

  const projects = text(await callTool('list_projects', {}));
  assert.ok(projects.includes(wtName), 'the same worktree shows under its project');

  const st = text(await callTool('project_status', { project: 'demo', worktree: wtName }));
  assert.match(st, /^demo {2}worktree /m);
  assert.match(st, /^base \S+@[0-9a-f]{12} {3}ahead 0 {2}behind 0$/m);
});

// ---------- tools/list annotations ----------

test('tools/list emits readOnly / destructive / idempotent annotations', async () => {
  const { body } = await rpc('tools/list');
  const byName = Object.fromEntries(body.result.tools.map(t => [t.name, t.annotations ?? {}]));
  assert.equal(byName.project_read.readOnlyHint, true);
  assert.equal(byName.list_projects.readOnlyHint, true);
  assert.equal(byName.project_diff.readOnlyHint, true);
  // The playbook introspection surface is read-only in the strong sense: it never
  // even materialises the ledger it reads.
  assert.equal(byName.list_playbooks.readOnlyHint, true);
  assert.equal(byName.describe_playbook.readOnlyHint, true);
  assert.equal(byName.playbook_state.readOnlyHint, true);
  assert.equal(byName.kill_instance.destructiveHint, true);
  assert.equal(byName.delete_worktree.destructiveHint, true);
  assert.equal(byName.merge_worktree.destructiveHint, true);
  // A prune kills and respawns the worker's subprocess.
  assert.equal(byName.prune_session.destructiveHint, true);
  assert.equal(byName.set_project_workspace.idempotentHint, true);
  assert.equal(byName.set_idle_timeout.idempotentHint, true);
  // A mutating, non-idempotent tool carries no hints.
  assert.deepEqual(byName.send_prompt, {});
});

// ---------- idle-wake heartbeat schema (the four turn-starting tools + set_idle_timeout) ----------

test('the turn-starting tools expose idleTimeoutSeconds and NO subscribe knob', async () => {
  const { body } = await rpc('tools/list');
  const byName = Object.fromEntries(body.result.tools.map(t => [t.name, t.inputSchema.properties]));
  for (const name of ['send_prompt', 'approve_plan', 'reject_plan', 'answer_question']) {
    const props = byName[name];
    assert.ok(props, `tools/list missing ${name}`);
    // The wake is a property of ownership — there is nothing to opt into or out of.
    assert.equal(props.subscribe, undefined, `${name} must expose no subscribe knob`);
    assert.equal(props.subscribeTimeoutMs, undefined, `${name} must not keep the old timeout param name`);
    assert.equal(props.idleTimeoutMs, undefined, `${name} must not keep the old ms param name`);
    // `integer`: the window is whole seconds, so 2.5 is refused rather than floored.
    assert.equal(props.idleTimeoutSeconds?.type, 'integer', `${name}.idleTimeoutSeconds should be integer`);
    // minimum + maximum together: bounds are what stopped idleTimeout:-5 going
    // through, to be silently swallowed by the default fallback.
    assert.equal(props.idleTimeoutSeconds?.minimum, 1, `${name}.idleTimeoutSeconds needs a floor`);
    assert.equal(props.idleTimeoutSeconds?.maximum, DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS,
      `${name}.idleTimeoutSeconds ceiling must be the floored default, so it can only shorten`);
    const required = body.result.tools.find(t => t.name === name).inputSchema.required ?? [];
    assert.ok(!required.includes('idleTimeoutSeconds'), `${name}.idleTimeoutSeconds must not be required`);
  }
});

test('set_idle_timeout requires a bounded, whole-second timeoutSeconds', async () => {
  const { body } = await rpc('tools/list');
  const tool = body.result.tools.find(t => t.name === 'set_idle_timeout');
  assert.ok(tool, 'set_idle_timeout is registered');
  assert.equal(tool.inputSchema.properties.timeoutMs, undefined, 'the ms param name is gone');
  assert.equal(tool.inputSchema.properties.timeoutSeconds.type, 'integer');
  assert.equal(tool.inputSchema.properties.timeoutSeconds.minimum, 1);
  assert.equal(tool.inputSchema.properties.timeoutSeconds.maximum, DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS);
  assert.deepEqual([...tool.inputSchema.required].sort(), ['sessionId', 'timeoutSeconds']);

  // `integer` is new on this param: a fractional window must be REFUSED at the
  // schema, not floored into a window the caller never asked for.
  const { body: call } = await rpc('tools/call', {
    name: 'set_idle_timeout', arguments: { sessionId: 'nope', timeoutSeconds: 2.5 },
  });
  assert.match(JSON.stringify(call), /must be integer/);
});

// ---------- send_prompt({forward}) schema ----------

test('send_prompt exposes forward as an optional object param', async () => {
  const { body } = await rpc('tools/list');
  const tool = body.result.tools.find(t => t.name === 'send_prompt');
  assert.ok(tool, 'tools/list missing send_prompt');
  assert.equal(tool.inputSchema.properties.forward?.type, 'object');
  assert.ok(!(tool.inputSchema.required ?? []).includes('forward'), 'forward must not be required — text stays the instruction');
});

// ---------- contract strictness: descriptions and refusals name what is valid ----------

// Invariant: pins are documented only by playbook surfaces — spawn_instance
// (top level and every property) never mentions a pin, and list_sessions no
// longer qualifies `resumes-hot` with one.
test('spawn_instance and list_sessions carry no playbook-pin prose', async () => {
  const { body } = await rpc('tools/list');
  const spawn = body.result.tools.find(t => t.name === 'spawn_instance');
  assert.doesNotMatch(spawn.description, /\bpin/i);
  for (const [k, p] of Object.entries(spawn.inputSchema.properties)) {
    assert.doesNotMatch(p.description ?? '', /\bpin/i, `spawn_instance.${k}`);
  }
  const ls = body.result.tools.find(t => t.name === 'list_sessions');
  assert.doesNotMatch(ls.description, /pinning/);
});

// Invariant: a path passed as `project` is still refused (no path→name
// resolution), and the refusal names the valid form — the NAME list_projects
// prints and its regex. list_projects' own description says the name is the
// argument.
test('a filesystem path as project is refused naming the expected form', async () => {
  const repo = await makeRealRepo('pathy');
  const r = await callTool('project_status', { project: repo });
  assert.equal(r.isError, true);
  const t = errText(r);
  assert.match(t, /list_projects/);
  assert.match(t, /NAME/);
  assert.ok(t.includes('^[a-zA-Z0-9._-]+$'), t);
  assert.ok(t.includes(JSON.stringify(repo)), t);

  const { body } = await rpc('tools/list');
  const lp = body.result.tools.find(x => x.name === 'list_projects');
  assert.match(lp.description, /NAME is the `project` argument/);
});

// Invariant: a resume whose location cannot be recovered is refused naming
// list_sessions as the recovery; a fresh spawn's refusal stays the plain
// `project required` and never mentions it.
test('spawn_instance: the resume "project required" names list_sessions, the fresh-spawn one does not', async () => {
  const resumed = await callTool('spawn_instance', { resume: '0badc0de-0000-4000-8000-000000000000' });
  assert.equal(resumed.isError, true, JSON.stringify(resumed));
  assert.match(errText(resumed), /^project required: .*list_sessions/);

  const fresh = await callTool('spawn_instance', {});
  assert.equal(fresh.isError, true, JSON.stringify(fresh));
  assert.equal(JSON.parse(fresh.content[1].text).error, 'project required');
  assert.doesNotMatch(errText(fresh), /list_sessions/);
});

// Invariant: `worktree:""` is refused by the schema on every MCP tool that
// takes a worktree — a census over tools/list, so a future tool's
// worktree/baseWorktree property is covered by construction.
test('every worktree param is minLength 1', async () => {
  const { body } = await rpc('tools/list');
  let seen = 0;
  for (const t of body.result.tools) {
    for (const [k, p] of Object.entries(t.inputSchema.properties ?? {})) {
      if (k !== 'worktree' && k !== 'baseWorktree') continue;
      seen++;
      assert.equal(p.minLength, 1, `${t.name}.${k} must declare minLength: 1`);
    }
  }
  assert.ok(seen > 0, 'premise: some tool takes a worktree');
});

// Invariant: `worktree:""` never reaches a handler — no filtering to nothing,
// no "not found", and above all no silent fall-through to the project root.
// One top-level test per tool (the file's beforeEach resets the store, which a
// subtest would inherit).
for (const [tool, args] of [
  ['list_sessions', { project: 'empt', worktree: '' }],
  ['project_diff', { project: 'empt', worktree: '' }],
  ['project_bash', { project: 'empt', worktree: '', command: 'pwd' }],
]) {
  test(`worktree:"" is refused by the schema, not run at the project root: ${tool}`, async () => {
    await makeRealRepo('empt');
    const r = await callTool(tool, args);
    assert.equal(r.isError, true, JSON.stringify(r));
    assert.equal(errText(r), "argument 'worktree' must be at least 1 character(s)");
  });
}

// Invariant: an unknown worktree's refusal lists the project's worktrees by
// exact name, on every surface that resolves one — and the match stays exact:
// a near-miss is refused, never resolved.
for (const tool of ['project_diff', 'list_sessions', 'spawn_instance']) {
  test(`unknown worktree lists exact names: ${tool}`, async () => {
    await makeRealRepo('names');
    const a = meta(await callTool('create_worktree', { project: 'names', name: 'alpha-one' }));
    const b = meta(await callTool('create_worktree', { project: 'names', name: 'beta-two' }));
    assert.ok(a.worktree && b.worktree, `premise: two worktrees: ${JSON.stringify([a, b])}`);
    const r = await callTool(tool, { project: 'names', worktree: 'alpha' });
    assert.equal(r.isError, true, JSON.stringify(r));
    const msg = errText(r);
    assert.match(msg, /worktree 'alpha' not found under project 'names' — its worktrees, by exact name: /);
    assert.ok(msg.includes(a.worktree) && msg.includes(b.worktree), msg);
  });
}

// ---------- project_diff within the MCP result budget ----------
// Every page's summed content[].text stays within MCP_RESULT_CHAR_BUDGET,
// every cut is flagged, and paging loses nothing.
const resultChars = r => r.content.reduce((n, c) => n + c.text.length, 0);
function assertInBudget(r, what) {
  assert.ok(resultChars(r) <= MCP_RESULT_CHAR_BUDGET, `${what}: ${resultChars(r)} chars, over ${MCP_RESULT_CHAR_BUDGET}`);
}
async function worktreeWithCommit(files) {
  await makeRealRepo('demo');
  const wt = meta(await callTool('create_worktree', { project: 'demo' }));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(wt.worktreePath, rel)), { recursive: true });
    await fs.writeFile(path.join(wt.worktreePath, rel), body);
  }
  await git(wt.worktreePath, 'add', '.');
  await git(wt.worktreePath, 'commit', '-q', '-m', 'bulk');
  return wt;
}
const manyFiles = (n, body) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`dir/file-${String(i).padStart(4, '0')}.txt`, body(i)]));

// Invariant: diff pages tile [0, totalLines) exactly — each page starts where
// the last one's nextOffset pointed — and every page fits the budget.
test('project_diff: a ~300 KB diff pages within the budget and the pages tile every line', async () => {
  const wt = await worktreeWithCommit({ 'big.txt': Array.from({ length: 3000 }, (_, i) => `line ${i} ${'z'.repeat(90)}`).join('\n') + '\n' });
  let offset = 0;
  let totalLines = null;
  for (let guard = 0; guard < 50; guard++) {
    const r = await callTool('project_diff', { project: 'demo', worktree: wt.worktree, offset });
    assertInBudget(r, `page at ${offset}`);
    const m = meta(r);
    assert.equal(m.offset, offset, 'each page starts at the previous nextOffset');
    totalLines ??= m.totalLines;
    if (!m.truncated) { assert.equal(m.nextOffset, null); offset = totalLines; break; }
    assert.ok(m.nextOffset > offset, 'offset advances');
    offset = m.nextOffset;
  }
  assert.ok(totalLines > 3000, 'premise: the diff is bigger than one page');
  assert.equal(offset, totalLines, 'the last page ends at totalLines');
});

// Invariant: a line no page can hold is cut to fit and flagged, never emitted
// whole past the budget.
test('project_diff: a single 120 KB line is cut, flagged lineTruncated, within the budget', async () => {
  const wt = await worktreeWithCommit({ 'wide.txt': 'w'.repeat(120 * 1024) + '\n' });
  let offset = 0;
  let sawCut = false;
  for (let guard = 0; guard < 10; guard++) {
    const r = await callTool('project_diff', { project: 'demo', worktree: wt.worktree, offset });
    assertInBudget(r, `page at ${offset}`);
    const m = meta(r);
    if (m.lineTruncated === true) sawCut = true;
    if (!m.truncated) break;
    offset = m.nextOffset;
  }
  assert.ok(sawCut, 'some page reports lineTruncated:true');
});

// Invariant: summary mode pages `files` by index — every page fits the budget,
// the union of pages is every changed file exactly once, and totals always
// cover the whole change set.
test('project_diff summary: ~1500 changed files page within the budget and lose none', async () => {
  const wt = await worktreeWithCommit(manyFiles(1500, i => `${i}\n`));
  const seen = [];
  let offset = 0;
  for (let guard = 0; guard < 50; guard++) {
    const r = await callTool('project_diff', { project: 'demo', worktree: wt.worktree, summary: true, offset });
    assert.equal(r.content.length, 1, 'summary is one JSON block');
    assertInBudget(r, `summary page at ${offset}`);
    const m = meta(r);
    assert.equal(m.totals.files, 1500, 'totals cover the whole change set on every page');
    seen.push(...m.files.map(f => f.path));
    if (!m.truncated) { assert.equal(m.nextOffset, null); break; }
    assert.equal(m.nextOffset, offset + m.files.length);
    offset = m.nextOffset;
  }
  assert.ok(offset > 0, 'premise: more than one page');
  assert.deepEqual([...seen].sort(), Object.keys(manyFiles(1500, () => '')).sort());
  assert.equal(new Set(seen).size, seen.length, 'no file on two pages');
});

// Invariant: the untracked side list is capped and flagged with the full count,
// in both modes, and the result stays within the budget.
test('project_diff: ~1500 untracked files are capped with untrackedTruncated + untrackedTotal in both modes', async () => {
  const wt = await worktreeWithCommit({ 'a.txt': 'a\n' });
  for (const [rel, body] of Object.entries(manyFiles(1500, i => `${i}\n`))) {
    await fs.mkdir(path.dirname(path.join(wt.worktreePath, rel)), { recursive: true });
    await fs.writeFile(path.join(wt.worktreePath, rel), body);
  }
  const d = await callTool('project_diff', { project: 'demo', worktree: wt.worktree });
  assertInBudget(d, 'diff mode');
  const dm = meta(d);
  assert.equal(dm.untrackedTruncated, true);
  assert.equal(dm.untrackedTotal, 1500);
  assert.ok(dm.untracked.length > 0 && dm.untracked.length < 1500);

  const s = await callTool('project_diff', { project: 'demo', worktree: wt.worktree, summary: true });
  assertInBudget(s, 'summary mode');
  const sm = meta(s);
  assert.equal(sm.uncommitted.untrackedTruncated, true);
  assert.equal(sm.uncommitted.untrackedTotal, 1500);
  assert.ok(sm.uncommitted.untracked.length > 0 && sm.uncommitted.untracked.length < 1500);
});

// Invariant: diff mode's file lists are capped and flagged with the full count,
// so a page over a wide change set still fits the budget.
test('project_diff: over ~1500 changed files, omittedFiles is capped with omittedFilesTruncated + omittedFilesTotal', async () => {
  const wt = await worktreeWithCommit(manyFiles(1500, i => `${i}\n`));
  const r = await callTool('project_diff', { project: 'demo', worktree: wt.worktree });
  assertInBudget(r, 'first diff page');
  const m = meta(r);
  assert.equal(m.truncated, true, 'premise: more than one page');
  assert.equal(m.omittedFilesTruncated, true);
  const includedCount = m.includedFilesTotal ?? m.includedFiles.length;
  assert.equal(m.omittedFilesTotal, 1500 - includedCount, 'the total counts every file this page omits');
  assert.ok(m.omittedFiles.length < m.omittedFilesTotal);
});

// Invariant: a summary page sized at the exact budget boundary never exceeds
// it — the frame it is fitted against is the longer of the two
// truncated/nextOffset spellings ({false, null} beats {true, <3 digits>}). The
// change set is calibrated so ALL files as one page would render at exactly
// MCP_RESULT_CHAR_BUDGET + 1 chars; that page must be cut, not returned whole.
test('project_diff summary: a change set one char over the budget as one page is cut, never over the budget', async () => {
  const wt = await worktreeWithCommit(manyFiles(300, () => 'x\n'));
  const probe = await callTool('project_diff', { project: 'demo', worktree: wt.worktree, summary: true });
  const pm = meta(probe);
  assert.equal(pm.truncated, false, 'premise: the probe is one whole page');
  const r = JSON.stringify(pm.files[0]).length + 1; // one uniform row, with its comma
  const needed = MCP_RESULT_CHAR_BUDGET + 1 - resultChars(probe);
  const k = Math.floor(needed / r) - 1;
  const rem = needed - k * r; // in [r, 2r): one row of padded name
  const extra = {};
  for (let i = 300; i < 300 + k; i++) extra[`dir/file-${String(i).padStart(4, '0')}.txt`] = 'x\n';
  extra[`dir/file-${String(300 + k).padStart(4, '0')}${'p'.repeat(rem - r)}.txt`] = 'x\n';
  for (const [rel, body] of Object.entries(extra)) await fs.writeFile(path.join(wt.worktreePath, rel), body);
  await git(wt.worktreePath, 'add', '.');
  await git(wt.worktreePath, 'commit', '-q', '-m', 'to the boundary');

  const first = await callTool('project_diff', { project: 'demo', worktree: wt.worktree, summary: true });
  assertInBudget(first, 'boundary page');
  const p1 = meta(first);
  assert.notEqual(p1.code, 'RESULT_OVER_BUDGET');
  assert.equal(p1.truncated, true, 'the boundary page is cut');
  const p2 = meta(await callTool('project_diff', { project: 'demo', worktree: wt.worktree, summary: true, offset: p1.nextOffset }));
  assert.equal(p2.truncated, false);
  // The fixture really sits on the boundary: every file as one last page
  // renders at exactly budget + 1.
  const whole = { ...p1, truncated: false, nextOffset: null, files: [...p1.files, ...p2.files] };
  assert.equal(whole.files.length, 301 + k);
  assert.equal(JSON.stringify(whole).length, MCP_RESULT_CHAR_BUDGET + 1);
});

// Invariant: the list_projects/NAME/not-a-path guidance belongs to ADDRESSING
// an existing project only — creating one (REST POST /api/projects, the
// new-project dialog) gets the neutral regex refusal, while the MCP `project`
// argument gets the guidance.
test('an invalid name: neutral on REST create, addressing guidance on an MCP project argument', async () => {
  const created = await api(baseUrl, 'POST', '/api/projects', { name: '/tmp/not a name' });
  assert.equal(created.status, 400);
  assert.equal(created.body.error, 'invalid project name (must match ^[a-zA-Z0-9._-]+$)');

  const addressed = await callTool('list_worktrees', { project: '/tmp/not a name' });
  assert.equal(addressed.isError, true);
  assert.match(errText(addressed), /invalid project name "\/tmp\/not a name" — pass the project's NAME as list_projects prints it/);
  assert.match(errText(addressed), /not its path/);
});
