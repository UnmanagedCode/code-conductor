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
const TOOL = `${PLUGIN_ID}__run`;

// Stand up a child that answers every POST with `body`, and hand `fn` both the
// bridge handler bound to it and an MCP router mounted over the same bridge.
// `body` may be swapped between calls via the setter; `opts.tool` merges into
// the manifest tool (e.g. `{outputSchema}` makes it a typed tool).
async function withChild(body, fn, { tool = {} } = {}) {
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
          tools: [{ name: 'run', description: 'test tool', inputSchema: { type: 'object' }, ...tool }],
        },
      },
    }],
    ensureStarted: async () => {},
    portFor: () => port,
    reportUpstreamFailure: () => {},
  });

  const tools = bridge.toolsFor();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, TOOL);
  const call = (args = {}, { format = 'text' } = {}) => tools[0].handler(args, { callerId: null, format });

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
  const base = `http://127.0.0.1:${mcpServer.address().port}/mcp`;
  let rpcId = 0;
  const rpc = async (format, method, params) => {
    const res = await fetch(`${base}?format=${format}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    return res.json();
  };
  // The whole JSON-RPC response of a tools/call on the plugin tool.
  const callMcp = (args = {}, { format = 'text' } = {}) => rpc(format, 'tools/call', { name: TOOL, arguments: args });
  const listMcp = async format => (await rpc(format, 'tools/list', {})).result.tools;
  const callRest = async (args = {}) => {
    const res = await fetch(`${base}/tools/${TOOL}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
    });
    return { status: res.status, body: await res.json() };
  };
  const listRest = async () => (await fetch(`${base}/tools`)).json();

  try {
    await fn({ call, callMcp, callRest, listMcp, listRest, seen, set: v => { current = v; } });
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
    const r = (await callMcp()).result;
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('line one\nline two')]);
  });
});

test('wire: {meta: null, text} → exactly one raw text block', async () => {
  await withChild({ meta: null, text: 'x' }, async ({ callMcp }) => {
    const r = (await callMcp()).result;
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('x')]);
  });
});

test('wire: {meta, text} keeps the compact-JSON meta block then raw bodies', async () => {
  await withChild({ meta: { page: 'Intro' }, text: ['first', 'second'] }, async ({ callMcp }) => {
    const r = (await callMcp()).result;
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('{"page":"Intro"}'), block('first'), block('second')]);
  });
});

test('wire: a text list with no meta keeps its null meta block', async () => {
  await withChild({ text: ['a', 'b'] }, async ({ callMcp }) => {
    const r = (await callMcp()).result;
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('null'), block('a'), block('b')]);
  });
});

test('wire: {result} stays one compact-JSON block', async () => {
  await withChild({ result: { x: 1 } }, async ({ callMcp }) => {
    const r = (await callMcp()).result;
    assert.ok(!r.isError);
    assert.deepEqual(r.content, [block('{"x":1}')]);
  });
});

// Every legacy body an untyped tool can answer, through text JSON-RPC, against
// the WHOLE result — the agent view must stay byte-identical. One subtest per
// row so no row hides behind another.
const LEGACY_TEXT = [
  ['{result}', { result: { x: 1 } }, { content: [block('{"x":1}')] }],
  ['{text} single string', { text: 'a\nb' }, { content: [block('a\nb')] }],
  ['{meta, text:[…]}', { meta: { p: 1 }, text: ['a', 'b'] }, { content: [block('{"p":1}'), block('a'), block('b')] }],
  ['{text:[…]} no meta', { text: ['a', 'b'] }, { content: [block('null'), block('a'), block('b')] }],
  ['{result, text}: text wins', { result: { x: 1 }, text: 'raw' }, { content: [block('raw')] }],
  ['{meta} only → null', { meta: { p: 1 } }, { content: [block('null')] }],
  ['degenerate {text:42} is stringified', { text: 42 }, { content: [block('null'), block('42')] }],
  ['{error}', { error: 'boom' }, { content: [block('boom'), block('{"error":"boom"}')], isError: true }],
];

test('text format: legacy bodies reply byte-identically', async t => {
  for (const [name, body, expected] of LEGACY_TEXT) {
    await t.test(name, async () => {
      await withChild(body, async ({ callMcp }) => {
        assert.deepEqual((await callMcp()).result, expected);
      });
    });
  }
});

test('text format: an untyped tool is listed with no outputSchema key', async () => {
  await withChild({ result: {} }, async ({ listMcp }) => {
    const entry = (await listMcp('text')).find(t => t.name === TOOL);
    assert.ok(entry, 'listed in text');
    assert.equal('outputSchema' in entry, false);
  });
});

// ---------- typed plugin tools: one reply shape per format ----------

const SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'string' } } },
  required: ['items'],
  additionalProperties: false,
};
const TYPED = { tool: { outputSchema: SCHEMA } };

test('request carries the format: text on JSON-RPC; json on JSON-RPC and on REST', async () => {
  await withChild({ text: 'ok' }, async ({ callMcp, seen }) => {
    await callMcp({}, { format: 'text' });
    assert.deepEqual(seen[0].body, { tool: 'run', arguments: {}, caller: { sessionId: null, project: null }, format: 'text' });
  });
  await withChild({ structured: { items: [] } }, async ({ callMcp, callRest, seen }) => {
    await callMcp({}, { format: 'json' });
    await callRest({});
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.deepEqual(s.body, { tool: 'run', arguments: {}, caller: { sessionId: null, project: null }, format: 'json' });
    }
  }, TYPED);
});

test('an untyped tool is text-only: absent from json listings, refused before the child is contacted', async () => {
  await withChild({ result: { x: 1 } }, async ({ callMcp, callRest, listMcp, listRest, seen }) => {
    assert.ok((await listMcp('text')).some(t => t.name === TOOL), 'listed in text');
    assert.equal((await listMcp('json')).some(t => t.name === TOOL), false, 'absent from json tools/list');
    assert.equal((await listRest()).some(t => t.name === TOOL), false, 'absent from GET /mcp/tools');

    const rpcRes = await callMcp({}, { format: 'json' });
    assert.equal(rpcRes.result, undefined);
    assert.equal(rpcRes.error.code, -32602);
    assert.equal(rpcRes.error.data.ok, false);
    assert.equal(rpcRes.error.data.code, 'TOOL_UNAVAILABLE_IN_FORMAT');
    assert.match(rpcRes.error.data.reason, /served in text format only/);

    const rest = await callRest({});
    assert.equal(rest.status, 404);
    assert.equal(rest.body.ok, false);
    assert.equal(rest.body.code, 'TOOL_UNAVAILABLE_IN_FORMAT');

    assert.equal(seen.length, 0, 'the child was never contacted');
    // Text still reaches it.
    assert.deepEqual((await callMcp()).result, { content: [block('{"x":1}')] });
    assert.equal(seen.length, 1);
  });
});

test('race guard: a json call on a tool whose manifest declares no outputSchema rejects at the bridge', async () => {
  await withChild({ result: { x: 1 } }, async ({ call, seen }) => {
    const e = await call({}, { format: 'json' }).then(() => null, err => err);
    assert.ok(e instanceof Error, 'rejects');
    assert.equal(e.code, 'TOOL_UNAVAILABLE_IN_FORMAT');
    assert.equal(seen.length, 0, 'the child was never contacted');
  });
});

test('a typed tool in json: {structured} becomes structuredContent; REST answers the object; listings carry the schema', async () => {
  const s = { items: ['a', 'b'] };
  await withChild({ structured: s }, async ({ callMcp, callRest, listMcp, listRest }) => {
    assert.deepEqual((await callMcp({}, { format: 'json' })).result, { content: [block(JSON.stringify(s))], structuredContent: s });
    assert.deepEqual(await callRest({}), { status: 200, body: s });
    assert.deepEqual((await listMcp('json')).find(t => t.name === TOOL).outputSchema, SCHEMA);
    assert.deepEqual((await listRest()).find(t => t.name === TOOL).outputSchema, SCHEMA);
    assert.equal('outputSchema' in (await listMcp('text')).find(t => t.name === TOOL), false, 'text tools/list carries no outputSchema');
  }, TYPED);
});

test('a typed tool in text: {text} and {meta, text:[…]} render exactly as legacy', async () => {
  await withChild({ text: 'a\nb' }, async ({ callMcp, set }) => {
    assert.deepEqual((await callMcp()).result, { content: [block('a\nb')] });
    set({ meta: { p: 1 }, text: ['a', 'b'] });
    assert.deepEqual((await callMcp()).result, { content: [block('{"p":1}'), block('a'), block('b')] });
  }, TYPED);
});

// The three channels a PLUGIN_REPLY_INVALID reaches, each read down to
// {code, reason, statusCode}.
async function invalidOnJsonRpc(callMcp) {
  const r = (await callMcp({}, { format: 'json' })).result;
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.ok, false);
  return r.structuredContent;
}
async function invalidOnRest(callRest) {
  const r = await callRest({});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  return r.body;
}
async function invalidOnText(callMcp) {
  const r = (await callMcp()).result;
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[1].text);
  assert.ok(r.content[0].text.endsWith('(HTTP 500)'), r.content[0].text);
  return { code: body.code, reason: body.error, statusCode: body.statusCode };
}
function assertInvalid(got, re) {
  assert.equal(got.code, 'PLUGIN_REPLY_INVALID', JSON.stringify(got));
  assert.equal(got.statusCode, 500);
  assert.match(got.reason, re);
}

test('PLUGIN_REPLY_INVALID: a typed tool answering json with anything but a valid {structured}', async t => {
  const KEYS = /plugin 'testplug' tool 'run': a json-format reply must be \{structured\} only; got keys: /;
  const cases = [
    ['{result}', { result: { items: [] } }, KEYS],
    ['{text}', { text: 'x' }, KEYS],
    ['{structured, text}', { structured: { items: [] }, text: 'x' }, KEYS],
    ['{structured, meta}', { structured: { items: [] }, meta: {} }, KEYS],
    ['{structured, result}', { structured: { items: [] }, result: {} }, KEYS],
    ['a structured array', { structured: [] }, /'structured' must be a JSON object, got array/],
    ['a structured null', { structured: null }, /'structured' must be a JSON object, got null/],
    ['a structured failing its schema', { structured: { items: [1] } }, /'structured' does not match its outputSchema: \$\.items\[0\]: expected string, got integer/],
    ['a structured missing a required property', { structured: {} }, /'structured' does not match its outputSchema: \$: missing required 'items'/],
  ];
  await withChild(null, async ({ callMcp, callRest, set, seen }) => {
    for (const [name, body, re] of cases) {
      await t.test(name, async () => {
        set(body);
        assertInvalid(await invalidOnJsonRpc(callMcp), re);
        assertInvalid(await invalidOnRest(callRest), re);
      });
    }
    assert.equal(seen.length, cases.length * 2, 'every case reached the child');
  }, TYPED);
});

test('PLUGIN_REPLY_INVALID: a typed tool answering text with anything but {text, meta?}', async t => {
  const KEYS = /plugin 'testplug' tool 'run': a text-format reply must be \{text, meta\?\}; got keys: /;
  const cases = [
    ['{result}', { result: { x: 1 } }],
    ['{structured}', { structured: { items: [] } }],
    ['{text, structured}', { text: 'x', structured: { items: [] } }],
    ['{text, result}', { text: 'x', result: {} }],
    ['{meta} only', { meta: { p: 1 } }],
  ];
  await withChild(null, async ({ callMcp, set }) => {
    for (const [name, body] of cases) {
      await t.test(name, async () => {
        set(body);
        assertInvalid(await invalidOnText(callMcp), KEYS);
      });
    }
  }, TYPED);
});

test('PLUGIN_REPLY_INVALID: an untyped tool answering text with {structured}', async () => {
  await withChild({ structured: { x: 1 } }, async ({ callMcp }) => {
    assertInvalid(await invalidOnText(callMcp), /a text-format reply must be \{text, meta\?\}; got keys: structured/);
  });
});

test('a plugin error code rides on all three channels; a malformed one is PLUGIN_REPLY_INVALID', async t => {
  await withChild({ error: 'gone', code: 'NOT_FOUND' }, async ({ callMcp, callRest, set }) => {
    await t.test('a valid code', async () => {
      set({ error: 'gone', code: 'NOT_FOUND' });
      const j = await callMcp({}, { format: 'json' });
      assert.deepEqual(j.result.structuredContent, { ok: false, code: 'NOT_FOUND', reason: 'gone' });
      assert.equal(j.result.isError, true);
      assert.deepEqual((await callMcp()).result, { content: [block('gone'), block('{"error":"gone","code":"NOT_FOUND"}')], isError: true });
      assert.deepEqual(await callRest({}), { status: 200, body: { ok: false, code: 'NOT_FOUND', reason: 'gone' } });
    });
    for (const code of ['nope', 42]) {
      await t.test(`code ${JSON.stringify(code)}`, async () => {
        set({ error: 'boom', code });
        const re = new RegExp(`error carries an invalid code ${JSON.stringify(code)} \\(must match .*\\): boom`);
        assertInvalid(await invalidOnJsonRpc(callMcp), re);
        assertInvalid(await invalidOnRest(callRest), re);
        assertInvalid(await invalidOnText(callMcp), re);
      });
    }
  }, TYPED);
});

// True when any object at any depth carries a `truncated` key.
function hasTruncated(v) {
  if (Array.isArray(v)) return v.some(hasTruncated);
  if (v && typeof v === 'object') return 'truncated' in v || Object.values(v).some(hasTruncated);
  return false;
}

test('json: a large structured reply arrives complete on JSON-RPC and REST — no cap, no truncated flag', async () => {
  // 9 strings of 1 MiB: past every 8 MiB JSON ceiling, MCP_RESULT_CHAR_BUDGET and JSON_ECHO_CAP.
  const rows = Array.from({ length: 9 }, (_, i) => String.fromCharCode(97 + i).repeat(1024 * 1024));
  const input = { rows };
  const schema = { type: 'object', properties: { rows: { type: 'array', items: { type: 'string' } } }, required: ['rows'], additionalProperties: false };
  await withChild({ structured: input }, async ({ callMcp, callRest }) => {
    const { result } = await callMcp({}, { format: 'json' });
    assert.equal(result.isError, undefined);
    assert.equal(hasTruncated(result), false);
    assert.deepEqual(result.structuredContent, input);
    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].text === JSON.stringify(input), 'the text block is the whole JSON');
    const rest = await callRest({});
    assert.equal(rest.status, 200);
    assert.equal(hasTruncated(rest.body), false);
    assert.deepEqual(rest.body, input);
  }, { tool: { outputSchema: schema } });
});
