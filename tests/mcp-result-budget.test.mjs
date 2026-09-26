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
import { bootServer, registerLocalProject } from './helpers.mjs';
import { buildTools } from '../src/mcp/tools.ts';
import { boundResult } from '../src/mcp/server.ts';
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

// Invariant: a thrown error's isError envelope is bounded too — error prose that
// echoes a huge argument is cut with an in-band marker, the code/statusCode that
// carry the error's meaning survive whole, and the cut is logged.
test('dispatch: an error echoing a huge argument is cut to the budget, keeping its code', async () => {
  const ctx = await bootServer({});
  const origError = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a.join(' ')); };
  const call = async (name, args) => {
    const res = await fetch(ctx.baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const { result } = await res.json();
    assert.equal(result.isError, true, name);
    assert.equal(result.content.length, 2, `${name}: still the prose + structured envelope`);
    const chars = result.content.reduce((n, c) => n + c.text.length, 0);
    assert.ok(chars <= MCP_RESULT_CHAR_BUDGET, `${name}: ${chars} chars`);
    const structured = JSON.parse(result.content[1].text);
    assert.match(structured.error, /… \[error message cut: \d+ chars\]$/, name);
    assert.ok(result.content[0].text.startsWith(structured.error), `${name}: both blocks carry the same cut message`);
    assert.ok(logged.some(l => l.includes(name) && l.includes('cut to fit')), `${name}: the cut is logged`);
    return { prose: result.content[0].text, structured };
  };
  try {
    const dir = path.join(ctx.projectsRoot, 'errp');
    await fs.mkdir(dir, { recursive: true });
    await registerLocalProject('errp', dir);

    const read = await call('project_read', { project: 'errp', relativePath: 'nope/' + 'x'.repeat(60_000) });
    assert.equal(read.structured.code, 'ENAMETOOLONG');

    const diff = await call('project_diff', { project: 'errp', worktree: 'w'.repeat(60_000) });
    assert.equal(diff.structured.code, 'NOT_FOUND');
    assert.equal(diff.structured.statusCode, 404);
    assert.match(diff.prose, /\(HTTP 404\)$/);
  } finally { console.error = origError; await ctx.close(); }
});
