// The MCP result-budget backstop — boundResult in src/mcp/server.ts, applied in
// dispatch to every core tool's content. A census over the real registry
// (buildTools()), one subtest per tool, so a future core tool gets its own row
// by construction.
//
// Invariant: any core tool's content over MCP_RESULT_CHAR_BUDGET becomes a
// RESULT_OVER_BUDGET soft refusal whose `completed` says whether the call
// already took effect (true unless the tool is annotated read-only); content
// at the budget exactly passes through untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, registerLocalProject, api, waitFor } from './helpers.mjs';
import { buildTools } from '../src/mcp/tools.ts';
import { boundResult, boundToolCall, capEcho } from '../src/mcp/server.ts';
import { MCP_RESULT_CHAR_BUDGET } from '../src/mcp/content.ts';

test('every core tool: over-budget content becomes RESULT_OVER_BUDGET, at-budget content passes', async (t) => {
  const tools = buildTools();
  assert.ok(tools.length > 0, 'premise: the registry is not empty');
  const origError = console.error;
  console.error = () => {};
  try {
    for (const tool of tools) {
      await t.test(tool.name, () => {
        // Split over two blocks: the budget is on the SUM of content[].text.
        const over = [
          { type: 'text', text: '{}' },
          { type: 'text', text: 'x'.repeat(MCP_RESULT_CHAR_BUDGET - 1) },
        ];
        const out = boundResult(tool, over);
        assert.equal(out.length, 1);
        const refusal = JSON.parse(out[0].text);
        assert.equal(refusal.ok, false);
        assert.equal(refusal.code, 'RESULT_OVER_BUDGET');
        assert.equal(refusal.tool, tool.name);
        assert.equal(refusal.chars, MCP_RESULT_CHAR_BUDGET + 1);
        assert.equal(refusal.budget, MCP_RESULT_CHAR_BUDGET);
        assert.equal(refusal.completed, !tool.annotations?.readOnlyHint);
        assert.match(refusal.reason, refusal.completed ? /completed, but .*do not re-run it blindly/ : /a cc defect; narrow the call/);

        const at = [
          { type: 'text', text: '{}' },
          { type: 'text', text: 'x'.repeat(MCP_RESULT_CHAR_BUDGET - 2) },
        ];
        assert.equal(boundResult(tool, at), at, 'at the budget exactly, the content is returned as is');
      });
    }
  } finally { console.error = origError; }
});

// Invariant: dispatch applies the backstop to a real core tool's result — a
// read tool that overflows (project_status' top-level listing is not paged)
// answers RESULT_OVER_BUDGET, completed:false, instead of an oversized result.
test('dispatch: an overflowing core read tool answers RESULT_OVER_BUDGET instead of the oversized result', async () => {
  const ctx = await bootServer({});
  const origError = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    const dir = path.join(ctx.projectsRoot, 'wide');
    await fs.mkdir(dir, { recursive: true });
    await registerLocalProject('wide', dir);
    await Promise.all(Array.from({ length: 2500 }, (_, i) =>
      fs.writeFile(path.join(dir, `a-rather-long-file-name-${String(i).padStart(5, '0')}.txt`), '')));
    const res = await fetch(ctx.baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'project_status', arguments: { project: 'wide' } } }),
    });
    const { result } = await res.json();
    assert.equal(result.content.length, 1);
    const refusal = JSON.parse(result.content[0].text);
    assert.equal(refusal.code, 'RESULT_OVER_BUDGET');
    assert.equal(refusal.tool, 'project_status');
    assert.equal(refusal.completed, false);
    assert.ok(refusal.chars > MCP_RESULT_CHAR_BUDGET);
    assert.ok(logged.some(l => l.includes('RESULT_OVER_BUDGET') && l.includes('project_status')), 'the overflow is logged');
  } finally { console.error = origError; await ctx.close(); }
});

// ── the response boundary: refusals and errors echoing caller strings ──────
// Every tools/call response and every JSON-RPC error passes one boundary
// (boundToolCall / rpcError in src/mcp/server.ts). One test per branch shape.
const HUGE = 60_000;
const contentChars = result => result.content.reduce((n, c) => n + c.text.length, 0);
const MARKER = / … \[cut: \d+ chars\] … /;
async function rpcRaw(baseUrl, method, params, caller) {
  const res = await fetch(baseUrl + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}
async function withLog(fn) {
  const origError = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a.join(' ')); };
  try { return await fn(logged); } finally { console.error = origError; }
}

// Invariant: a thrown error's isError envelope is bounded — the huge echoed
// argument is cut with the in-band marker in both blocks, the code/statusCode
// that carry the error's meaning survive whole (and the prose keeps its
// "(HTTP 404)" suffix), and the cut is logged.
test('boundary, thrown error: an error echoing a huge argument is cut to the budget, keeping its code', async () => {
  const ctx = await bootServer({});
  try {
    await withLog(async (logged) => {
      const dir = path.join(ctx.projectsRoot, 'errp');
      await fs.mkdir(dir, { recursive: true });
      await registerLocalProject('errp', dir);
      const call = async (name, args) => {
        const { result } = await rpcRaw(ctx.baseUrl, 'tools/call', { name, arguments: args });
        assert.equal(result.isError, true, name);
        assert.equal(result.content.length, 2, `${name}: still the prose + structured envelope`);
        assert.ok(contentChars(result) <= MCP_RESULT_CHAR_BUDGET, `${name}: ${contentChars(result)} chars`);
        const structured = JSON.parse(result.content[1].text);
        assert.match(structured.error, MARKER, name);
        assert.match(result.content[0].text, MARKER, name);
        assert.ok(logged.some(l => l.includes(name) && l.includes('cut to fit')), `${name}: the cut is logged`);
        return { prose: result.content[0].text, structured };
      };
      const read = await call('project_read', { project: 'errp', relativePath: 'nope/' + 'x'.repeat(HUGE) });
      assert.equal(read.structured.code, 'ENAMETOOLONG');

      const diff = await call('project_diff', { project: 'errp', worktree: 'w'.repeat(HUGE) });
      assert.equal(diff.structured.code, 'NOT_FOUND');
      assert.equal(diff.structured.statusCode, 404);
      assert.match(diff.prose, /\(HTTP 404\)$/);
    });
  } finally { await ctx.close(); }
});

// Invariant: the unknown-tool refusal is bounded — the echoed name is cut with
// the marker, the refusal still reads as one, and the cut is logged.
test('boundary, unknown tool: a huge tool name is cut to the budget', async () => {
  const ctx = await bootServer({});
  try {
    await withLog(async (logged) => {
      const { result } = await rpcRaw(ctx.baseUrl, 'tools/call', { name: 'n'.repeat(HUGE), arguments: {} });
      assert.equal(result.isError, true);
      assert.ok(contentChars(result) <= MCP_RESULT_CHAR_BUDGET, `${contentChars(result)} chars`);
      assert.match(result.content[0].text, /^unknown tool: n+ … \[cut: \d+ chars\] … n+$/);
      assert.ok(logged.some(l => l.includes('cut to fit')), 'the cut is logged');
    });
  } finally { await ctx.close(); }
});

// Invariant: the argument-validation refusal is bounded — a huge unexpected
// key is cut with the marker, and the refusal keeps its wording and the
// allowed-parameter list.
test('boundary, validateArgs: a huge unexpected argument key is cut to the budget', async () => {
  const ctx = await bootServer({});
  try {
    await withLog(async (logged) => {
      const { result } = await rpcRaw(ctx.baseUrl, 'tools/call', { name: 'list_sessions', arguments: { ['k'.repeat(HUGE)]: 1 } });
      assert.equal(result.isError, true);
      assert.ok(contentChars(result) <= MCP_RESULT_CHAR_BUDGET, `${contentChars(result)} chars`);
      assert.match(result.content[0].text, /^unexpected argument 'k+ … \[cut: \d+ chars\] … /);
      assert.match(result.content[0].text, /Allowed: project, worktree, includeArchived$/);
      assert.ok(logged.some(l => l.includes('list_sessions') && l.includes('cut to fit')), 'the cut is logged');
    });
  } finally { await ctx.close(); }
});

// Invariant: a playbook-gate refusal is bounded — a huge echoed `stage` is cut
// inside the JSON refusal, which still parses and keeps ok/code intact.
test('boundary, playbook gate: a STAGE_UNKNOWN refusal echoing a huge stage is cut to the budget', async () => {
  // A scenario keeps the conductor's fake CLI alive, so it stays a live caller.
  const ctx = await bootServer({ scenarioPath: path.join(import.meta.dirname, 'fixtures', 'scenario-ws.json') });
  try {
    await withLog(async (logged) => {
      await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
      const conductor = await api(ctx.baseUrl, 'POST', '/api/instances', {
        project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'enforce',
      });
      assert.equal(conductor.status, 201, JSON.stringify(conductor.body));
      await waitFor(() => ctx.instances.get(conductor.body.id)?.status === 'idle');
      const { result } = await rpcRaw(ctx.baseUrl, 'tools/call', {
        name: 'spawn_instance', arguments: { project: 'demo', playbook: 'solo', stage: 's'.repeat(HUGE) },
      }, conductor.body.id);
      assert.ok(contentChars(result) <= MCP_RESULT_CHAR_BUDGET, `${contentChars(result)} chars`);
      const refusal = JSON.parse(result.content[0].text);
      assert.equal(refusal.ok, false);
      assert.equal(refusal.code, 'STAGE_UNKNOWN');
      assert.match(refusal.reason, MARKER);
      assert.ok(logged.some(l => l.includes('spawn_instance') && l.includes('cut to fit')), 'the cut is logged');
    });
  } finally { await ctx.close(); }
});

// Invariant: a JSON-RPC error envelope is bounded — `method not found` echoing
// a huge method keeps its JSON-RPC code, and the message is cut with the marker.
test('boundary, JSON-RPC error: a huge unknown method is cut to the budget', async () => {
  const ctx = await bootServer({});
  try {
    await withLog(async (logged) => {
      const body = await rpcRaw(ctx.baseUrl, 'm'.repeat(HUGE), {});
      assert.equal(body.error.code, -32601);
      assert.ok(JSON.stringify(body).length <= MCP_RESULT_CHAR_BUDGET, `${JSON.stringify(body).length} chars`);
      assert.match(body.error.message, /^method not found: m+ … \[cut: \d+ chars\] … m+$/);
      assert.ok(logged.some(l => l.includes('JSON-RPC') && l.includes('cut to fit')), 'the cut is logged');
    });
  } finally { await ctx.close(); }
});

// Invariant: capEcho's output is bounded by the cap plus its marker, for every
// cap — including caps too small for any tail — and it keeps only what it says.
test('capEcho: output is bounded for small caps, and within cap + marker for any cap', () => {
  const s = 'e'.repeat(60_000);
  for (const cap of [1, 2, 3, 4, 7, 64, 6250]) {
    const out = capEcho(s, cap);
    const marker = ` … [cut: ${s.length} chars] … `;
    assert.ok(out.includes(marker), `cap ${cap}: marker present`);
    assert.ok(out.length <= cap + marker.length, `cap ${cap}: ${out.length} chars, over ${cap + marker.length}`);
    assert.equal(out.length - marker.length, cap, `cap ${cap}: exactly cap chars of the input kept`);
  }
  assert.equal(capEcho('short', 1000), 'short', 'a string within the cap is returned as is');
});

// Invariant: a refusal or error that stays over the budget even at the smallest
// echo cap — many short strings, none of which capEcho can shrink — is never
// returned oversized: it becomes RESULT_OVER_BUDGET naming the tool and the
// original size, within the budget, with `completed` false for a refusal (no
// handler ran) and, for a thrown error, true unless the tool is read-only;
// isError is carried over from the response it replaces.
test('boundToolCall: an unfittable refusal or error becomes RESULT_OVER_BUDGET', () => {
  const tools = buildTools();
  const core = new Set(tools);
  const spawn = tools.find(t => t.name === 'spawn_instance');
  const read = tools.find(t => t.name === 'project_read');
  assert.ok(spawn && !spawn.annotations?.readOnlyHint && read?.annotations?.readOnlyHint, 'premise: one acting, one read-only tool');
  // An ambiguous-prefix refusal naming thousands of candidate sessions.
  const matches = Array.from({ length: 20_000 }, (_, i) => `s${String(i).padStart(7, '0')}`);
  const text = JSON.stringify({ ok: false, code: 'SESSION_AMBIGUOUS', sessionId: 's', reason: 'ambiguous', matches });
  const chars = text.length;
  assert.ok(chars > MCP_RESULT_CHAR_BUDGET, 'premise: over budget');

  const cases = [
    { tool: spawn, outcome: 'refused', isError: undefined, completed: false },
    { tool: spawn, outcome: 'error', isError: true, completed: true },
    { tool: read, outcome: 'error', isError: true, completed: false },
  ];
  const origError = console.error;
  console.error = () => {};
  try {
    for (const c of cases) {
      const result = { content: [{ type: 'text', text }], ...(c.isError ? { isError: true } : {}) };
      const out = boundToolCall({ result, tool: c.tool, outcome: c.outcome }, core);
      const what = `${c.tool.name}/${c.outcome}`;
      assert.equal(out.content.length, 1, what);
      assert.ok(out.content[0].text.length <= MCP_RESULT_CHAR_BUDGET, what);
      const r = JSON.parse(out.content[0].text);
      assert.equal(r.ok, false, what);
      assert.equal(r.code, 'RESULT_OVER_BUDGET', what);
      assert.equal(r.tool, c.tool.name, what);
      assert.equal(r.chars, chars, what);
      assert.equal(r.budget, MCP_RESULT_CHAR_BUDGET, what);
      assert.equal(r.completed, c.completed, what);
      assert.equal(out.isError, c.isError, what);
    }
  } finally { console.error = origError; }
});
