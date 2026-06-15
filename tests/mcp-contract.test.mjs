// Integration tests for the overhauled MCP I/O contract:
//   - validateArgs constraint enforcement (pattern / min-max / length / array items)
//   - unknown-property rejection (incl. dropped legacy aliases)
//   - the multi-block output format (metadata block + raw text body blocks)
//   - ok/refusal normalization with stable codes
//   - error statusCode/code surfacing
//   - tools/list annotations
// Drives the /mcp transport via fetch, same shape a real MCP client would use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_INSTANCE = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let nextRpcId = 1;
async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  return { status: res.status, body: await res.json() };
}
async function callTool(baseUrl, name, args) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args });
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
function errText(result) { return result.content.map(c => c.text).join('\n'); }

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}
async function makeRealRepo(projectsRoot, name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
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
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/call', {
      name: 'create_project', arguments: { name: 'bad name with spaces' },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /must match \^\[a-zA-Z0-9/);
  } finally { await close(); }
});

test('validateArgs enforces minLength/maxLength (create_workspace name)', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const short = await rpc(baseUrl, 'tools/call', { name: 'create_workspace', arguments: { name: '' } });
    assert.equal(short.body.result.isError, true);
    assert.match(short.body.result.content[0].text, /at least 1 character/);
    const long = await rpc(baseUrl, 'tools/call', { name: 'create_workspace', arguments: { name: 'x'.repeat(41) } });
    assert.equal(long.body.result.isError, true);
    assert.match(long.body.result.content[0].text, /at most 40 character/);
  } finally { await close(); }
});

test('validateArgs enforces minimum/maximum (get_worktree_diff contextLines, get_recent_messages count)', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const hi = await rpc(baseUrl, 'tools/call', {
      name: 'get_worktree_diff', arguments: { project: 'x', worktree: 'y', contextLines: 99 },
    });
    assert.equal(hi.body.result.isError, true);
    assert.match(hi.body.result.content[0].text, /<= 50/);

    const lo = await rpc(baseUrl, 'tools/call', { name: 'get_recent_messages', arguments: { sessionId: 'x', count: 0 } });
    assert.equal(lo.body.result.isError, true);
    assert.match(lo.body.result.content[0].text, />= 1/);

    const big = await rpc(baseUrl, 'tools/call', { name: 'get_recent_messages', arguments: { sessionId: 'x', count: 99 } });
    assert.equal(big.body.result.isError, true);
    assert.match(big.body.result.content[0].text, /<= 50/);
  } finally { await close(); }
});

test('validateArgs enforces array items.type (get_worktree_diff paths)', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/call', {
      name: 'get_worktree_diff', arguments: { project: 'x', worktree: 'y', paths: ['ok', 7] },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /paths\[1\]' must be string/);
  } finally { await close(); }
});

// ---------- unknown-property rejection (clean break: aliases gone) ----------

test('unknown property is rejected with an actionable message', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/call', {
      name: 'list_sessions', arguments: { project: 'a', bogus: 1 },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /unexpected argument 'bogus'/);
    assert.match(body.result.content[0].text, /Allowed: project, worktree/);
  } finally { await close(); }
});

test('dropped legacy aliases (instanceId / worktreeName) are rejected as unknown', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const a = await rpc(baseUrl, 'tools/call', {
      name: 'approve_plan', arguments: { sessionId: 'x', instanceId: 'x' },
    });
    assert.equal(a.body.result.isError, true);
    assert.match(a.body.result.content[0].text, /unexpected argument 'instanceId'/);

    const w = await rpc(baseUrl, 'tools/call', {
      name: 'get_worktree_diff', arguments: { project: 'p', worktree: 'w', worktreeName: 'w' },
    });
    assert.equal(w.body.result.isError, true);
    assert.match(w.body.result.content[0].text, /unexpected argument 'worktreeName'/);
  } finally { await close(); }
});

test('legacy {id} worker handle is rejected (clean break — sessionId only)', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    // The pure-legacy shape {id} fails the now-required sessionId.
    const legacy = await rpc(baseUrl, 'tools/call', {
      name: 'kill_instance', arguments: { id: 'x' },
    });
    assert.equal(legacy.body.result.isError, true);
    assert.match(legacy.body.result.content[0].text, /missing required argument: sessionId/);

    // And `id` alongside sessionId is explicitly rejected as unexpected — there
    // is no accept-both shim.
    for (const name of ['send_prompt', 'get_recent_messages', 'kill_instance', 'set_mode']) {
      const r = await rpc(baseUrl, 'tools/call', {
        name, arguments: { sessionId: 'x', id: 'x', text: 'hi', mode: 'plan' },
      });
      assert.equal(r.body.result.isError, true, `${name} should reject legacy {id}`);
      assert.match(r.body.result.content[0].text, /unexpected argument 'id'/,
        `${name} should name 'id' as unexpected`);
    }
  } finally { await close(); }
});

// ---------- multi-block output ----------

test('read_file returns a metadata block + a raw UNESCAPED text body block', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    const raw = 'line1\n"quoted" line\nline3\n';
    await fs.writeFile(path.join(repoPath, 'multi.txt'), raw);

    const res = await callTool(ctx.baseUrl, 'read_file', { project: 'demo', relativePath: 'multi.txt' });
    assert.equal(res.content.length, 2, 'metadata block + one body block');
    const m = meta(res);
    assert.equal(m.encoding, 'utf8');
    assert.equal(m.lineCount, 3);
    assert.equal(m.lineCountExact, true);
    assert.equal(m.truncated, false);
    assert.equal(m.content, undefined, 'body is NOT inlined into the metadata block');
    // The body block carries the literal bytes — no JSON escaping.
    assert.equal(bodies(res)[0], raw);
  } finally { await ctx.close(); }
});

test('read_file truncated fast path reports lineCountExact:false', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await fs.writeFile(path.join(repoPath, 'big.txt'), 'abcdefghij\n'.repeat(100));
    const res = await callTool(ctx.baseUrl, 'read_file', { project: 'demo', relativePath: 'big.txt', maxBytes: 25 });
    const m = meta(res);
    assert.equal(m.truncated, true);
    assert.equal(m.lineCountExact, false, 'partial final line on the byte-capped fast path');
  } finally { await ctx.close(); }
});

test('read_file binary returns a base64 body block', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await fs.writeFile(path.join(repoPath, 'b.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const res = await callTool(ctx.baseUrl, 'read_file', { project: 'demo', relativePath: 'b.bin' });
    const m = meta(res);
    assert.equal(m.encoding, 'base64');
    assert.equal(bodies(res)[0], Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('base64'));
  } finally { await ctx.close(); }
});

test('get_worktree_diff diff mode → 2 blocks, head is a SHA, no sizeBytes; summary → 1 block', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = meta(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtPath = path.join(ctx.projectsRoot, wt.worktree);
    await fs.writeFile(path.join(wtPath, 'new.txt'), 'fresh\n');
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'add new.txt');

    const diff = await callTool(ctx.baseUrl, 'get_worktree_diff', { project: 'demo', worktree: wt.worktree });
    assert.equal(diff.content.length, 2);
    const dm = meta(diff);
    assert.match(dm.head, /^[0-9a-f]{40}$/);
    assert.equal(dm.sizeBytes, undefined);
    assert.equal(dm.worktreeName, undefined);
    assert.equal(dm.worktree, wt.worktree);
    assert.match(bodies(diff)[0], /\+fresh/);

    const summary = await callTool(ctx.baseUrl, 'get_worktree_diff', { project: 'demo', worktree: wt.worktree, summary: true });
    assert.equal(summary.content.length, 1, 'summary mode is a single JSON block');
    const sm = meta(summary);
    assert.equal(sm.summary, true);
    assert.match(sm.head, /^[0-9a-f]{40}$/);
  } finally { await ctx.close(); }
});

test('get_recent_messages → metadata + one raw body block per message (block k+1 ↔ messages[k])', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = meta(await callTool(ctx.baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(ctx.instances, spawn.sessionId)?.status === 'idle');

    // Empty → just the metadata block, no body blocks.
    const empty = await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId });
    assert.equal(empty.content.length, 1);
    assert.deepEqual(meta(empty).messages, []);

    await callTool(ctx.baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one', wait: true, waitTimeoutMs: 5000 });
    await callTool(ctx.baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'two', wait: true, waitTimeoutMs: 5000 });

    const res = await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId, count: 2 });
    const m = meta(res);
    assert.equal(m.messages.length, 2);
    // One raw body per message, in order.
    assert.equal(res.content.length, 3); // meta + 2 bodies
    const b = bodies(res);
    assert.equal(b[0], 'First ');
    assert.equal(b[1], 'Second!');
    // Metadata carries char counts + flags, not the prose itself.
    assert.equal(m.messages[0].textChars, 'First '.length);
    assert.equal(m.messages[0].textTruncated, false);
    assert.equal(m.messages[0].text, undefined);
    assert.equal(m.messages[0].index, 0);
  } finally { await ctx.close(); }
});

// ---------- ok / refusal normalization ----------

test('acknowledgement tools no longer carry a constant ok:true', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = meta(await callTool(ctx.baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(ctx.instances, spawn.sessionId));

    const sent = meta(await callTool(ctx.baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'go' }));
    assert.equal(sent.ok, undefined);
    assert.equal(sent.sessionId, spawn.sessionId);

    const ws = meta(await callTool(ctx.baseUrl, 'create_workspace', { name: 'WS' }));
    assert.equal(ws.ok, undefined);
    assert.equal(ws.added, true);

    const killed = meta(await callTool(ctx.baseUrl, 'kill_instance', { sessionId: spawn.sessionId }));
    assert.equal(killed.ok, undefined);
    assert.equal(killed.sessionId, spawn.sessionId);
  } finally { await ctx.close(); }
});

test('delete_worktree soft-refuses (ok:false + code) on dirty and attached, never throws', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_INSTANCE });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');

    // Attached: live instance in a fresh worktree.
    const spawn = meta(await callTool(ctx.baseUrl, 'spawn_instance', {
      project: 'demo', mode: 'bypassPermissions', createWorktree: true,
    }));
    await waitFor(() => instForSession(ctx.instances, spawn.sessionId)?.worktree);
    const wtName = instForSession(ctx.instances, spawn.sessionId).worktree.worktreeName;

    const attached = meta(await callTool(ctx.baseUrl, 'delete_worktree', { project: 'demo', worktree: wtName }));
    assert.equal(attached.ok, false);
    assert.equal(attached.code, 'WORKTREE_ATTACHED');

    await callTool(ctx.baseUrl, 'kill_instance', { sessionId: spawn.sessionId });

    // Dirty: uncommitted change in the worktree.
    await fs.writeFile(path.join(ctx.projectsRoot, wtName, 'dirty.txt'), 'uncommitted\n');
    const dirty = meta(await callTool(ctx.baseUrl, 'delete_worktree', { project: 'demo', worktree: wtName }));
    assert.equal(dirty.ok, false);
    assert.equal(dirty.code, 'WORKTREE_DIRTY');

    // force:true succeeds and returns bare data (no ok).
    const done = meta(await callTool(ctx.baseUrl, 'delete_worktree', { project: 'demo', worktree: wtName, force: true }));
    assert.equal(done.ok, undefined);
    assert.equal(done.worktree, wtName);
  } finally { await ctx.close(); }
});

// ---------- error statusCode / code surfacing ----------

test('errors surface prose (HTTP <code>) plus a structured {code, statusCode} block', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const { body } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'read_file', arguments: { project: 'demo', relativePath: 'nope.txt' },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /file not found.*\(HTTP 404\)/);
    const structured = JSON.parse(body.result.content[1].text);
    assert.equal(structured.statusCode, 404);
    assert.equal(structured.code, 'NOT_FOUND');
  } finally { await ctx.close(); }
});

test('get_worktree_diff invalid baseRef surfaces statusCode 400', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = meta(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const { body } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'get_worktree_diff', arguments: { project: 'demo', worktree: wt.worktree, baseRef: '--evil' },
    });
    assert.equal(body.result.isError, true);
    assert.match(errText(body.result), /\(HTTP 400\)/);
    assert.equal(JSON.parse(body.result.content[1].text).statusCode, 400);
  } finally { await ctx.close(); }
});

test('promote_session on a non-temp session surfaces statusCode 400', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_INSTANCE });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const spawn = meta(await callTool(ctx.baseUrl, 'spawn_instance', { project: 'demo', temp: false }));
    await waitFor(() => instForSession(ctx.instances, spawn.sessionId)?.status === 'idle');
    const { body } = await rpc(ctx.baseUrl, 'tools/call', { name: 'promote_session', arguments: { sessionId: spawn.sessionId } });
    assert.equal(body.result.isError, true);
    assert.match(errText(body.result), /not temp.*\(HTTP 400\)/);
    assert.equal(JSON.parse(body.result.content[1].text).code, 'BAD_REQUEST');
  } finally { await ctx.close(); }
});

// ---------- project_status dirty cap ----------

test('project_status caps the dirty list with dirtyTruncated + dirtyTotal', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await Promise.all(Array.from({ length: 520 }, (_, i) =>
      fs.writeFile(path.join(repoPath, `f${i}.txt`), 'x\n')));
    const st = meta(await callTool(ctx.baseUrl, 'project_status', { project: 'demo' }));
    assert.equal(st.dirtyTruncated, true);
    assert.equal(st.dirty.length, 500);
    assert.ok(st.dirtyTotal >= 520);
  } finally { await ctx.close(); }
});

// ---------- tools/list annotations ----------

test('tools/list emits readOnly / destructive / idempotent annotations', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/list');
    const byName = Object.fromEntries(body.result.tools.map(t => [t.name, t.annotations ?? {}]));
    assert.equal(byName.read_file.readOnlyHint, true);
    assert.equal(byName.list_projects.readOnlyHint, true);
    assert.equal(byName.get_worktree_diff.readOnlyHint, true);
    assert.equal(byName.kill_instance.destructiveHint, true);
    assert.equal(byName.delete_worktree.destructiveHint, true);
    assert.equal(byName.merge_worktree.destructiveHint, true);
    assert.equal(byName.set_project_workspace.idempotentHint, true);
    assert.equal(byName.unsubscribe_from_idle.idempotentHint, true);
    // A mutating, non-idempotent tool carries no hints.
    assert.deepEqual(byName.send_prompt, {});
  } finally { await close(); }
});
