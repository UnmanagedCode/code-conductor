#!/usr/bin/env node
// Per-tool and per-view size of the core MCP tool list every session loads.
//
// Metric: UTF-8 bytes of `description` plus `JSON.stringify(inputSchema)`, summed
// over `capableTools(format, ALL_CAPS, kind)` (src/mcp/tools.ts) for each VIEW.
// outputSchema bytes are reported in their own column and are NOT part of the
// metric (tools/list shows them in the JSON view only). Approximate tokens are
// bytes / BYTES_PER_TOKEN.
//
// Usage: node scripts/mcp-tool-bytes.mjs [--root <tree>]
//   --root  a source tree to measure instead of this repo; to compare against a
//           base revision:
//     D=$(mktemp -d); git archive <rev> | tar -x -C "$D"; ln -s "$(realpath node_modules)" "$D/node_modules"
//     node scripts/mcp-tool-bytes.mjs --root "$D"      # base
//     node scripts/mcp-tool-bytes.mjs                  # this tree

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const ALL_CAPS = { remoteSystems: true, fuseUnion: true, voice: true };
export const BYTES_PER_TOKEN = 4;
export const VIEWS = ['text', 'json'].flatMap(format =>
  ['conductor', 'worker', 'anonymous'].map(kind => ({ view: `${format}/${kind}`, format, kind })));

const bytes = s => Buffer.byteLength(s, 'utf8');

// `capableTools` is src/mcp/tools.ts's export, passed in so a caller can measure
// any tree.
export function measure(capableTools) {
  return VIEWS.map(({ view, format, kind }) => {
    const tools = capableTools(format, ALL_CAPS, kind).map(t => {
      const description = bytes(t.description);
      const inputSchema = bytes(JSON.stringify(t.inputSchema));
      return {
        name: t.name, description, inputSchema, total: description + inputSchema,
        outputSchema: bytes(JSON.stringify(t.outputSchema)),
      };
    });
    const sum = k => tools.reduce((n, t) => n + t[k], 0);
    return {
      view, tools,
      description: sum('description'), inputSchema: sum('inputSchema'),
      total: sum('total'), outputSchema: sum('outputSchema'),
    };
  });
}

const tokens = n => Math.round(n / BYTES_PER_TOKEN);

async function main() {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { capableTools } = await import(pathToFileURL(path.join(root, 'src/mcp/tools.ts')).href);
  const views = measure(capableTools);
  for (const v of views) {
    console.log(`## ${v.view}`);
    console.log(['tool', 'description', 'inputSchema', 'total', '~tokens', 'outputSchema'].join('\t'));
    for (const t of [...v.tools].sort((a, b) => b.total - a.total)) {
      console.log([t.name, t.description, t.inputSchema, t.total, tokens(t.total), t.outputSchema].join('\t'));
    }
    console.log();
  }
  console.log('## summary');
  console.log(['view', 'tools', 'description', 'inputSchema', 'total', '~tokens', 'outputSchema'].join('\t'));
  for (const v of views) {
    console.log([v.view, v.tools.length, v.description, v.inputSchema, v.total, tokens(v.total), v.outputSchema].join('\t'));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
