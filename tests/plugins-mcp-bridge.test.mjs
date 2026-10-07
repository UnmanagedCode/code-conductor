// Unit tests for the plugin MCP bridge's success-body handling. createMcpBridge
// is fully dependency-injected, so these drive the handler directly against a
// throwaway node:http child — no bootServer, no real plugin.
//
// Focus: the opt-in raw-text channel. A child may return {text, meta?} instead
// of {result} to have its output emitted as raw, UNESCAPED content blocks. The
// bridge's job is producing the right payload. The wire-level tests mount the
// real MCP router over the same bridge and pin the content[] each body shape
// produces through the real toolsCall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createMcpBridge } from '../src/plugins/mcpBridge.ts';
import { buildMcpRouter } from '../src/mcp/server.ts';
import { isTextPayload, isTextResult } from '../src/mcp/content.ts';

const PLUGIN_ID = 'testplug';

// Stand up a child that answers every POST with `body`, and return a handler
// bound to it. `body` may be swapped between calls via the returned setter.
async function withChild(body, fn) {
  let current = body;
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(raw) });
      const { status = 200, payload } = typeof current === 'function' ? current() : { payload: current };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const bridge = createMcpBridge({
    instances: { anyForSession: () => undefined },
    listMcpPlugins: () => [{
      id: PLUGIN_ID,
      manifest: {
        mcp: {
          endpoint: '/api/mcp',
          timeoutMs: 5000,
          tools: [{ name: 'run', description: 'test tool', inputSchema: { type: 'object' } }],
        },
      },
    }],
    ensureStarted: async () => {},
    portFor: () => port,
    reportUpstreamFailure: () => {},
  });

  const tools = bridge.toolsFor();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, `${PLUGIN_ID}__run`);
  const call = (args = {}) => tools[0].handler(args, { callerId: null });

  const router = buildMcpRouter({
    instances: null,
    pluginHost: { init: async () => {}, toolsFor: () => bridge.toolsFor() },
    playbookGate: { check: async ({ args }) => ({ args }) },
  });
  const app = express();
  app.use('/mcp', router);
  const mcpServer = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const mcpPort = mcpServer.address().port;
  let rpcId = 0;
  const callMcp = async (args = {}) => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
        params: { name: `${PLUGIN_ID}__run`, arguments: args },
      }),
    });
    return (await res.json()).result;
  };

  try {
    await fn({ call, callMcp, seen, set: v => { current = v; } });
  } finally {
    await new Promise(resolve => mcpServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
}

test('text as a single string with no meta → a text result, left un-escaped', async () => {
  await withChild({ text: 'line one\nline two' }, async ({ call }) => {
    const r = await call();
    assert.ok(isTextResult(r), 'result is tagged as a text result');
    assert.ok(!isTextPayload(r), 'no metadata-carrying payload');
    assert.equal(r.text, 'line one\nline two');
    // The whole point: a real newline survives, rather than being escaped
    // into the two characters \ and n by JSON.stringify.
    assert.ok(r.text.includes('\n'));
  });
});

test('text as a list → one body per entry, in order', async () => {
  await withChild({ text: ['first', 'second', 'third'] }, async ({ call }) => {
    const r = await call();
    assert.ok(isTextPayload(r));
    assert.deepEqual(r.bodies, ['first', 'second', 'third']);
  });
});

test('a plain {result} body is returned unchanged (back-compat path)', async () => {
  await withChild({ result: { x: 1, nested: ['a'] } }, async ({ call }) => {
    const r = await call();
    assert.equal(isTextPayload(r), false, 'not a text payload');
    assert.deepEqual(r, { x: 1, nested: ['a'] });
  });
});

test('{meta, text} carries meta through alongside the bodies', async () => {
  await withChild({ meta: { page: 'Intro', tokens: 12 }, text: 'the body' }, async ({ call }) => {
    const r = await call();
    assert.ok(isTextPayload(r));
    assert.deepEqual(r.meta, { page: 'Intro', tokens: 12 });
    assert.deepEqual(r.bodies, ['the body']);
  });
});

test('sending both result and text is a contract violation that degrades: text wins', async () => {
  await withChild({ result: { x: 1 }, text: 'raw' }, async ({ call }) => {
    const r = await call();
    assert.ok(isTextResult(r), 'text takes the text path (single string, no meta)');
    assert.equal(r.text, 'raw');
    assert.equal(r.result, undefined, 'the ignored result is not smuggled through');
  });
});

test('meta with no text falls through to the result path and is silently dropped', async () => {
  await withChild({ meta: { page: 'Intro' } }, async ({ call }) => {
    const r = await call();
    assert.equal(isTextPayload(r), false);
    assert.equal(r, undefined, 'no result key → undefined; meta is lost');
  });
});

test('the raw-text path never throws on degenerate text values', async () => {
  await withChild({ text: null }, async ({ call, set }) => {
    const nulled = await call();
    assert.ok(isTextPayload(nulled), 'text:null still selects the payload path');
    assert.deepEqual(nulled.bodies, [], 'zero bodies — meta block only');

    set({ text: 42 });
    const numeric = await call();
    assert.ok(isTextPayload(numeric));
    assert.equal(numeric.bodies.length, 1);
    // The server stringifies each body at emit time (String(b)).
    assert.equal(String(numeric.bodies[0]), '42');
  });
});

test('200 + {error} still throws a plain tool error with no HTTP status', async () => {
  await withChild({ error: 'boom' }, async ({ call }) => {
    const e = await call().then(() => null, err => err);
    assert.ok(e instanceof Error, 'rejects');
    assert.match(e.message, /boom/);
    assert.equal(e.statusCode, undefined, 'tool-level failure carries no status code');
  });
});

const block = text => ({ type: 'text', text });

test('wire: {text} with no meta → exactly one raw text block', async () => {
  await withChild({ text: 'line one\nline two' }, async ({ callMcp }) => {
    const r = await callMcp();
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('line one\nline two')]);
  });
});

test('wire: {meta: null, text} → exactly one raw text block', async () => {
  await withChild({ meta: null, text: 'x' }, async ({ callMcp }) => {
    const r = await callMcp();
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('x')]);
  });
});

test('wire: {meta, text} keeps the compact-JSON meta block then raw bodies', async () => {
  await withChild({ meta: { page: 'Intro' }, text: ['first', 'second'] }, async ({ callMcp }) => {
    const r = await callMcp();
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('{"page":"Intro"}'), block('first'), block('second')]);
  });
});

test('wire: a text list with no meta keeps its null meta block', async () => {
  await withChild({ text: ['a', 'b'] }, async ({ callMcp }) => {
    const r = await callMcp();
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('null'), block('a'), block('b')]);
  });
});

test('wire: {result} stays one compact-JSON block', async () => {
  await withChild({ result: { x: 1 } }, async ({ callMcp }) => {
    const r = await callMcp();
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('{"x":1}')]);
  });
});
