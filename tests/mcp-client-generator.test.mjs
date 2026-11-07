// The generated /mcp clients (src/mcp/client/), rendered without a server:
// the fixture registry's rendering is byte-pinned, the real registry renders
// deterministically and completely, unsupported schemas fail loudly, and the
// output imports in Python and typechecks as JSDoc.
//
// Regenerate the snapshots after an intended renderer change:
//   node --input-type=module -e "import fs from 'node:fs'; import { FIXTURE_TOOLS } from './tests/fixtures/mcp-client/registry.mjs'; import { renderPythonClient } from './src/mcp/client/python.ts'; import { renderNodeClient } from './src/mcp/client/node.ts'; fs.writeFileSync('tests/fixtures/mcp-client/expected/conductor_client.py', renderPythonClient(FIXTURE_TOOLS)); fs.writeFileSync('tests/fixtures/mcp-client/expected/conductor_client.mjs', renderNodeClient(FIXTURE_TOOLS));"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import * as tools from '../src/mcp/tools.ts';
import { hostPlatform } from '../src/platform/index.ts';
import * as python from '../src/mcp/client/python.ts';
import * as node from '../src/mcp/client/node.ts';
import { FIXTURE_TOOLS } from './fixtures/mcp-client/registry.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'mcp-client');
const EXPECTED_PY = path.join(FIXTURES, 'expected', 'conductor_client.py');
const EXPECTED_MJS = path.join(FIXTURES, 'expected', 'conductor_client.mjs');
const REPO = path.join(import.meta.dirname, '..');
const ALL_ON = { remoteSystems: true, fuseUnion: true, voice: true };

const realTools = (caps = hostPlatform.capabilities) => tools.capableTools('json', caps);
const pyMethods = src => [...src.matchAll(/^ {4}def (\w+)\(self/gm)].map(m => m[1]).filter(n => n !== '__init__' && n !== 'call');
const jsMethods = src => [...src.matchAll(/^ {2}(\w+)\(args(?: = \{\})?\) \{$/gm)].map(m => m[1]);

function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 60000, ...opts }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

// null when python3 is absent or older than the client's 3.11 floor.
async function python311() {
  const r = await run('python3', ['-c', 'import sys;print(sys.version_info>=(3,11))']);
  if (r.err) return null;
  return r.stdout.trim() === 'True' ? 'python3' : null;
}

test('the fixture registry renders byte-for-byte to the committed snapshots', () => {
  assert.equal(python.renderPythonClient(FIXTURE_TOOLS), readFileSync(EXPECTED_PY, 'utf8'));
  assert.equal(node.renderNodeClient(FIXTURE_TOOLS), readFileSync(EXPECTED_MJS, 'utf8'));
});

test('two independent builds of the real registry render byte-identical clients', () => {
  assert.equal(python.renderPythonClient(realTools(ALL_ON)), python.renderPythonClient(realTools(ALL_ON)));
  assert.equal(node.renderNodeClient(realTools(ALL_ON)), node.renderNodeClient(realTools(ALL_ON)));
});

test('the real render has one method per served core tool and none for a capability-off tool', () => {
  const on = realTools(ALL_ON).map(t => t.name);
  assert.deepEqual(pyMethods(python.renderPythonClient(realTools(ALL_ON))), on);
  assert.deepEqual(jsMethods(node.renderNodeClient(realTools(ALL_ON))), on);

  const off = { ...ALL_ON, remoteSystems: false };
  const gated = tools.buildTools('json').filter(t => t.requires === 'remoteSystems').map(t => t.name);
  assert.ok(gated.includes('system_bash'), 'the registry still gates system_bash on remoteSystems');
  const served = realTools(off).map(t => t.name);
  for (const name of gated) assert.ok(!served.includes(name), `${name} is not served without remoteSystems`);
  assert.deepEqual(pyMethods(python.renderPythonClient(realTools(off))), served);
  assert.deepEqual(jsMethods(node.renderNodeClient(realTools(off))), served);
});

test('an unsupported schema keyword fails the render, naming the tool and the path', () => {
  const bad = [{
    name: 'odd_tool', description: 'x',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { pick: { oneOf: [{ type: 'string' }] } }, required: ['pick'] },
  }];
  for (const render of [python.renderPythonClient, node.renderNodeClient]) {
    assert.throws(() => render(bad), /unsupported schema keyword 'oneOf' at odd_tool\.outputSchema\.properties\.pick/);
  }
  // An annotation keyword is accepted on an input schema only.
  const annotatedOutput = [{ ...bad[0], outputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 0 } } } }];
  assert.throws(() => python.renderPythonClient(annotatedOutput), /unsupported schema keyword 'minimum' at odd_tool\.outputSchema\.properties\.n/);
});

const bareTool = (name, outputSchema = { type: 'object', properties: {} }) =>
  ({ name, description: 'x', inputSchema: { type: 'object', properties: {} }, outputSchema });

test('a tool named like a client member fails the render', () => {
  for (const name of ['call', 'url', 'constructor', '__init__']) {
    const re = new RegExp(`a tool named '${name}', which is a client member`);
    assert.throws(() => python.renderPythonClient([bareTool(name)]), re);
    assert.throws(() => node.renderNodeClient([bareTool(name)]), re);
  }
});

test('two tools whose generated type names collide fail the render', () => {
  // Pascal('foo_bar') === Pascal('foo__bar'): both results are FooBarResult.
  const twins = [bareTool('foo_bar'), bareTool('foo__bar')];
  assert.throws(() => python.renderPythonClient(twins), /type name 'FooBarResult' is generated twice/);
  assert.throws(() => node.renderNodeClient(twins), /type name 'FooBarResult' is generated twice/);
});

test('a literal whose rendering would close a JSDoc comment fails the render, naming the tool and the path', () => {
  const viaConst = [bareTool('odd_tool', { type: 'object', properties: { k: { const: 'a*/b' } }, required: ['k'] })];
  const viaEnum = [bareTool('odd_tool', { type: 'object', properties: { k: { enum: ['ok', 'x*/'] } }, required: ['k'] })];
  for (const bad of [viaConst, viaEnum]) {
    for (const render of [python.renderPythonClient, node.renderNodeClient]) {
      assert.throws(() => render(bad), /mcp client: a literal .* containing '\*\/' at odd_tool\.outputSchema\.properties\.k/);
    }
  }
});

test('the Python clients import, and a TypedDict carries its schema\'s required split', async (t) => {
  const py = await python311();
  if (!py) { t.diagnostic('python3 >= 3.11 not installed — the Python import was not run'); return; }
  const dir = await mkdtemp('cc-mcp-client-py-');
  const real = path.join(dir, 'conductor_client.py');
  await fs.writeFile(real, python.renderPythonClient(realTools()));
  const script = [
    'import importlib.util, json, sys',
    'def load(p, n):',
    '    s = importlib.util.spec_from_file_location(n, p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m',
    'fx = load(sys.argv[1], "fixture_client"); real = load(sys.argv[2], "conductor_client")',
    'td = fx.MakeThingResult',
    'print(json.dumps({"required": sorted(td.__required_keys__), "optional": sorted(td.__optional_keys__),',
    '                  "create": sorted(real.CreateWorkspaceResult.__required_keys__)}))',
  ].join('\n');
  const r = await run(py, ['-I', '-B', '-c', script, EXPECTED_PY, real]);
  assert.equal(r.err, null, r.stderr);
  const got = JSON.parse(r.stdout);
  const schema = FIXTURE_TOOLS[0].outputSchema;
  const keys = Object.keys(schema.properties);
  assert.deepEqual(got.required, [...schema.required].sort());
  assert.deepEqual(got.optional, keys.filter(k => !schema.required.includes(k)).sort());
  assert.deepEqual(got.create, ['added', 'name']);
});

test('the Node clients typecheck as JSDoc, and their types are neither any nor broken', async () => {
  const dir = await mkdtemp('cc-mcp-client-js-');
  await fs.writeFile(path.join(dir, 'conductor_client.mjs'), node.renderNodeClient(realTools()));
  await fs.copyFile(EXPECTED_MJS, path.join(dir, 'fixture_client.mjs'));
  await fs.copyFile(path.join(FIXTURES, 'consumer.mjs'), path.join(dir, 'consumer.mjs'));
  await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      allowJs: true, checkJs: true, strict: true, noEmit: true,
      module: 'nodenext', moduleResolution: 'nodenext', target: 'es2024', lib: ['es2024'],
      types: ['node'], typeRoots: [path.join(REPO, 'node_modules', '@types')], skipLibCheck: true,
    },
    files: ['fixture_client.mjs', 'conductor_client.mjs', 'consumer.mjs'],
  }));
  const r = await run(process.execPath, [path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(dir, 'tsconfig.json')]);
  assert.equal(r.err, null, `tsc reported diagnostics:\n${r.stdout}${r.stderr}`);
});
