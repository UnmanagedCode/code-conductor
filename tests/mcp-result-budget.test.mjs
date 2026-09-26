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
