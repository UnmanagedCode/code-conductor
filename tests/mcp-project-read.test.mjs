// Integration tests for project_read line-param enhancements:
// lineNumbers, offset/limit, lineCount, binary passthrough.
// Kept in a separate file to avoid pushing mcp.test.mjs past its 30s budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let nextRpcId = 1;

async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function callTool(baseUrl, name, args) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args });
  return body.result;
}

// project_read is multi-block: content[0] is JSON metadata, content[1] is the
// raw body. Merge the body back onto the metadata as `content` for assertions.
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const meta = JSON.parse(result.content[0].text);
  return { ...meta, content: result.content.slice(1).map(c => c.text).join('') };
}

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function makeRealRepo(projectsRoot, name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(repoPath, '.gitkeep'), '');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
  return repoPath;
}

test('project_read: lineNumbers, offset/limit range, past-EOF grace, binary ignores params', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    // 5-line file ending with newline
    await fs.writeFile(path.join(repoPath, 'five.txt'), 'alpha\nbeta\ngamma\ndelta\nepsilon\n');

    // (1) lineCount present on basic read (fast path — no line params)
    const basic = unwrap(await callTool(ctx.baseUrl, 'project_read', {
      project: 'demo', relativePath: 'five.txt',
    }));
    assert.equal(basic.lineCount, 5);
    assert.equal(basic.content, 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
    assert.equal(basic.startLine, undefined); // no range → no startLine

    // (2) lineNumbers:true — verify cat-n prefix format
    const numbered = unwrap(await callTool(ctx.baseUrl, 'project_read', {
      project: 'demo', relativePath: 'five.txt', lineNumbers: true,
    }));
    assert.equal(numbered.lineCount, 5);
    const lines = numbered.content.split('\n');
    assert.match(lines[0], /^\s*1\talpha$/);
    assert.match(lines[2], /^\s*3\tgamma$/);
    assert.match(lines[4], /^\s*5\tepsilon$/);

    // (3) offset+limit range — lines 2–3; not at EOF so no trailing newline
    const range = unwrap(await callTool(ctx.baseUrl, 'project_read', {
      project: 'demo', relativePath: 'five.txt', offset: 2, limit: 2,
    }));
    assert.equal(range.startLine, 2);
    assert.equal(range.endLine, 3);
    assert.equal(range.lineCount, 5);
    assert.equal(range.content, 'beta\ngamma');

    // (4) offset past EOF — graceful empty, lineCount still accurate
    const pastEof = unwrap(await callTool(ctx.baseUrl, 'project_read', {
      project: 'demo', relativePath: 'five.txt', offset: 100,
    }));
    assert.equal(pastEof.lineCount, 5);
    assert.equal(pastEof.content, '');
    assert.equal(pastEof.startLine, 100);
    assert.equal(pastEof.endLine, 100);

    // (5) binary file ignores line params — returns base64, no startLine/endLine/lineCount
    const binPath = path.join(repoPath, 'bytes.bin');
    await fs.writeFile(binPath, Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
    const bin = unwrap(await callTool(ctx.baseUrl, 'project_read', {
      project: 'demo', relativePath: 'bytes.bin',
      lineNumbers: true, offset: 2, limit: 1,
    }));
    assert.equal(bin.encoding, 'base64');
    assert.equal(bin.startLine, undefined);
    assert.equal(bin.lineCount, undefined);
  } finally { await ctx.close(); }
});
