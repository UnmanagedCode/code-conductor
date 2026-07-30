// Unit tests for the plugin MCP bridge's success-body handling. createMcpBridge
// is fully dependency-injected, so these drive the handler directly against a
// throwaway node:http child — no bootServer, no real plugin.
//
// Focus: the opt-in raw-text channel. A child may return {text, meta?} instead
// of {result} to have its output emitted as raw, UNESCAPED content blocks. The
// bridge's job is producing the right payload; where the blocks land in
// content[] is src/mcp/server.js's job and is not re-asserted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMcpBridge } from '../src/plugins/mcpBridge.js';
import { isTextPayload } from '../src/mcp/content.js';

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

  const tools = bridge.toolsFor(null);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, `${PLUGIN_ID}__run`);
  const call = (args = {}) => tools[0].handler(args, { callerId: null });

  try {
    await fn({ call, seen, set: v => { current = v; } });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('text as a single string → a text payload with one body, left un-escaped', async () => {
  await withChild({ text: 'line one\nline two' }, async ({ call }) => {
    const r = await call();
    assert.ok(isTextPayload(r), 'result is tagged as a text payload');
    assert.deepEqual(r.bodies, ['line one\nline two']);
    assert.equal(r.meta, null, 'omitted meta becomes null');
    // The whole point: a real newline survives, rather than being escaped
    // into the two characters \ and n by JSON.stringify.
    assert.ok(r.bodies[0].includes('\n'));
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
    assert.ok(isTextPayload(r), 'text takes the payload path');
    assert.deepEqual(r.bodies, ['raw']);
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
