// The core tool list every session loads is a recurring per-session cost, so its
// size is ratcheted: each view's description + inputSchema bytes
// (scripts/mcp-tool-bytes.mjs) stay within a budget. A new tool or a longer
// description must raise its view's budget in the same change, which is the
// moment to ask whether the text belongs in a description at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capableTools } from '../src/mcp/tools.ts';
import { measure } from '../scripts/mcp-tool-bytes.mjs';

const BUDGET = {
  'text/conductor': 60075,
  'text/worker': 35209,
  'text/anonymous': 60075,
  'json/conductor': 56917,
  'json/worker': 32050,
  'json/anonymous': 56917,
};

const views = measure(capableTools);

test('every measured view has a budget, and the budget names no other view', () => {
  assert.deepEqual(views.map(v => v.view).sort(), Object.keys(BUDGET).sort());
});

for (const v of views) {
  test(`${v.view}: the tool list has content and fits its byte budget`, () => {
    assert.ok(v.tools.length > 0 && v.total > 0, `${v.view} measured nothing`);
    assert.ok(v.total <= BUDGET[v.view],
      `${v.view} is ${v.total} B (description + inputSchema) against a budget of ${BUDGET[v.view]} B`);
  });
}
