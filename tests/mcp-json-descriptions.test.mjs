// The JSON format's tool descriptions say what each tool does and leave the
// result's shape to its outputSchema: no text-view layout (renderings, content
// blocks) and no text-view context caps. TEXT_ONLY lists the phrases that only
// the text view's result clauses carry; test 1 keeps the list live against
// today's text descriptions, tests 2 and 3 keep every one of them out of both
// JSON listings (tools/list and the REST alias's GET /mcp/tools).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildMcpRouter } from '../src/mcp/server.ts';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';

const TEXT_ONLY = [
  /PLAIN TEXT/, /no JSON/, /content\[/, /metadata block/, /un-escaped/, /\bOUTPUT\b/,
  /compact[- ]JSON/, /one block per/i, /group header/, /marked LIVE/, /one line each/,
  /live N · inactive N/, /\+N archived/, /\bthe rendering\b/i, /single session line/,
  /worker block/, /`flags` line/, /resumes-hot/, /awaiting-user/, /`locked` marker/,
  /no[- ]commits[- ]yet/, /as a header/, /as printed/, /NOT ENUMERABLE/,
  /<stage>@<liveness>/, /pin \{json\}/, /in sections/, /FILES, DIRTY/,
  /dirty list is capped/, /MCP result/, /most one result carries/,
  /(?<![A-Z_])BASH_OUTPUT_CAP/, /bash output cap/, /TOOL_ARG_VALUE_CAP/,
  /per-argument descriptor/i, /emit tool inputs verbatim/, /omitted:true, chars/,
  /--- message i\/N/, /quoted and truncated/, /capped; see historyTruncated/,
  /Large message text is capped/, /in one JSON block/, /<list>Truncated/,
  /omittedForBudget/, /normal result \{ok:false/, /not errors/,
  /Returns \[\{name, projectCount\}\]/, /Metadata includes/,
];

// [path, text] for a tool's description and every string `description` in
// its inputSchema, at any depth (properties, items.properties, …).
function descriptions(tool) {
  const out = [['description', tool.description]];
  const walk = (node, at) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${at}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') out.push([`${at}.description`, v]);
      else walk(v, `${at}.${k}`);
    }
  };
  walk(tool.inputSchema, 'inputSchema');
  return out;
}

function textOnlyHits(tools) {
  const hits = [];
  for (const tool of tools) {
    for (const [path, text] of descriptions(tool)) {
      for (const pattern of TEXT_ONLY) {
        if (pattern.test(text)) hits.push({ tool: tool.name, path, pattern: String(pattern) });
      }
    }
  }
  return hits;
}

let server;
let base;
const listings = {};

before(async () => {
  const router = buildMcpRouter({
    instances: null, pluginHost: null,
    playbookGate: createPlaybookGate({ instances: null }),
    capabilities: { remoteSystems: true, fuseUnion: true, voice: true },
  });
  const app = express();
  app.use('/mcp', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const rpcList = async query => {
    const res = await fetch(`${base}/mcp${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).result.tools;
  };
  listings.json = await rpcList('');
  listings.text = await rpcList('?format=text');
  const rest = await fetch(`${base}/mcp/tools`);
  assert.equal(rest.status, 200);
  listings.rest = await rest.json();
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('every TEXT_ONLY pattern matches at least one text-format description', () => {
  const texts = listings.text.flatMap(t => descriptions(t).map(([, s]) => s));
  const dead = TEXT_ONLY.filter(p => !texts.some(s => p.test(s))).map(String);
  assert.deepEqual(dead, []);
});

test('no JSON-format tools/list description carries a text-only phrase', () => {
  assert.deepEqual(textOnlyHits(listings.json), []);
});

test('no GET /mcp/tools description carries a text-only phrase', () => {
  assert.deepEqual(textOnlyHits(listings.rest), []);
});

test('the JSON and text listings name the same tools, each with a non-empty JSON description', () => {
  const names = tools => tools.map(t => t.name).sort();
  assert.deepEqual(names(listings.json), names(listings.text));
  assert.deepEqual(names(listings.rest), names(listings.json));
  const empty = [...listings.json, ...listings.rest]
    .flatMap(t => descriptions(t).filter(([, s]) => s.trim() === '').map(([p]) => `${t.name} ${p}`));
  assert.deepEqual(empty, []);
});
