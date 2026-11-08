// The TypeScript signature renderer (src/codeMode/tsSignature.ts): every core
// tool renders, each schema construct maps to its documented spelling, and the
// output is valid TypeScript.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderSignature } from '../src/codeMode/tsSignature.ts';
import { buildTools } from '../src/mcp/tools.ts';
import { RESERVED_METHODS } from '../src/codeMode/runtimeApi.ts';
import { FIXTURE_TOOLS } from './fixtures/code-mode/registry.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sig = (t, extra = {}) => renderSignature({ fnName: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, ...extra });
const make = FIXTURE_TOOLS.find(t => t.name === 'make_thing');

test('every core tool, in both formats, renders without throwing', () => {
  for (const format of ['json', 'text']) {
    for (const t of buildTools(format)) {
      assert.doesNotThrow(() => sig(t), `${format}/${t.name}`);
    }
  }
});

test('no core tool is named like a reserved method or a plugin wire name', () => {
  for (const t of buildTools('json')) {
    assert.ok(!RESERVED_METHODS.includes(t.name), t.name);
    assert.ok(!t.name.includes('__'), t.name);
  }
});

test('the declaration names the function, marks required args and types the result', () => {
  const out = sig(make);
  assert.match(out, /declare function make_thing\(args: MakeThingArgs\): Promise<MakeThingResult>;/);
  assert.match(out, /interface MakeThingArgs \{[\s\S]*\n {2}name: string;/);
  assert.match(out, /\n {2}count\?: number;/, 'an optional field takes ?');
  assert.match(out, /\n {2}label\?: string \| null;/, 'a type array is a union');
  assert.match(out, /\n {2}kind\?: "small" \| "large";/, 'an enum is a union of literals');
  assert.match(out, /\n {2}tags\?: string\[\];/, 'an array is T[]');
  assert.match(out, /\n {2}extra\?: Record<string, unknown>;/, 'a free-form object is a Record');
  assert.match(out, /\n {2}"x-origin"\?: string;/, 'a non-identifier key is quoted');
  assert.match(out, /@default 3/, 'a default is documented');
  assert.match(out, /scores: Record<string, number>;/);
  assert.match(out, /parts: MakeThingResultPartsItem\[\];/);
  assert.match(out, /state: "open" \| "closed" \| null;/);
  assert.match(out, /ok: true;/, 'a const is its literal');
  assert.match(out, /input: unknown;/, 'a schema with no type is unknown');
});

test('a union item is parenthesised inside an array', () => {
  const out = renderSignature({
    fnName: 'f', description: 'd',
    inputSchema: { type: 'object', properties: { xs: { type: 'array', items: { type: ['string', 'number'] } } } },
  });
  assert.match(out, /xs\?: \(string \| number\)\[\];/);
});

test('a tool with no outputSchema returns Promise<unknown>; none required makes args optional', () => {
  const out = renderSignature({ fnName: 'f', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } });
  assert.match(out, /declare function f\(args\?: FArgs\): Promise<unknown>;/);
});

test('a tool with no declared properties takes an optional record', () => {
  const out = renderSignature({ fnName: 'f', description: 'd', inputSchema: { type: 'object' } });
  assert.match(out, /declare function f\(args\?: Record<string, unknown>\)/);
});

test('a "*/" in a description or field description cannot close its doc comment', () => {
  const out = sig(make);
  const comments = out.match(/\/\*\*[\s\S]*?\*\//g) ?? [];
  assert.ok(comments.every(c => c.indexOf('*/') === c.length - 2), 'each comment ends only at its own close');
});

test('typeBase prefixes every named type, so two tools never clash', () => {
  const out = sig(make, { typeBase: 'AcmeMakeThing' });
  assert.match(out, /interface AcmeMakeThingArgs/);
  assert.doesNotMatch(out, /interface MakeThingArgs/);
});

test('an unsupported schema keyword throws, naming the tool and the path', () => {
  assert.throws(() => renderSignature({
    fnName: 'f', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string', format: 'uri' } } },
  }), /unsupported schema keyword 'format' at f\.inputSchema\.properties\.a/);
});

async function tsc(dir) {
  return await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(dir, 'tsconfig.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ code, out }));
  });
}

test('the declarations for every core tool plus the fixture typecheck with tsc', async () => {
  const dir = await mkdtemp('cc-sigs-');
  const decls = [...buildTools('json'), ...FIXTURE_TOOLS].map(t => sig(t));
  await fs.writeFile(path.join(dir, 'decls.ts'), decls.join('\n\n') + '\nexport {};\n');
  await fs.writeFile(path.join(dir, 'use.ts'), [
    "declare const r: Awaited<ReturnType<typeof make_thing>>;",
    "const id: string = r.id;",
    "// @ts-expect-error a required field is required",
    "make_thing({});",
    "make_thing({ name: 'a', count: 2 });",
    "export {};",
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'es2022', lib: ['es2022'], module: 'preserve', types: [], skipLibCheck: true },
    files: ['decls.ts', 'use.ts'],
  }));
  // `use.ts` is a script, not a module, so it sees decls.ts' globals only when
  // both are scripts: drop the module marker from decls.
  await fs.writeFile(path.join(dir, 'decls.ts'), decls.join('\n\n') + '\n');
  const r = await tsc(dir);
  assert.equal(r.code, 0, `tsc reported diagnostics:\n${r.out}`);
});
