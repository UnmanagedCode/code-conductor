// Integration tests for project_read line-param enhancements:
// lineNumbers, offset/limit, lineCount, binary passthrough.
// Kept in a separate file to avoid pushing mcp.test.mjs past its 30s budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, registerLocalProject} from './helpers.mjs';
import { MCP_RESULT_CHAR_BUDGET, MCP_BODY_BUDGET } from '../src/mcp/content.ts';

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
  await registerLocalProject(name, repoPath);
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

// ── the MCP result budget ───────────────────────────────────────────────────
// Every result's summed content[].text stays within MCP_RESULT_CHAR_BUDGET,
// every cut is flagged, and paging loses nothing.
const resultChars = r => r.content.reduce((n, c) => n + c.text.length, 0);

// 200 numbered lines of ~1 KB each: bigger than one result, every line distinct.
const BIG_LINES = Array.from({ length: 200 }, (_, i) => `${String(i + 1).padStart(4, '0')} ${'y'.repeat(1000)}`);

// Invariant: a default read of a file bigger than one result is capped, flagged
// and within the budget.
test('project_read: a default read of a 200 KB file is truncated and within the result budget', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await fs.writeFile(path.join(repoPath, 'big.txt'), BIG_LINES.join('\n') + '\n');
    const r = await callTool(ctx.baseUrl, 'project_read', { project: 'demo', relativePath: 'big.txt' });
    assert.ok(resultChars(r) <= MCP_RESULT_CHAR_BUDGET, `${resultChars(r)} chars`);
    assert.equal(unwrap(r).truncated, true);
  } finally { await ctx.close(); }
});

// Invariant: maxBytes above the maximum is refused by the schema naming the
// bound — never clamped.
test('project_read: maxBytes over the maximum is refused naming the bound', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const r = await callTool(ctx.baseUrl, 'project_read', {
      project: 'demo', relativePath: '.gitkeep', maxBytes: MCP_BODY_BUDGET + 1,
    });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, `argument 'maxBytes' must be <= ${MCP_BODY_BUDGET}`);
  } finally { await ctx.close(); }
});

// Invariant: a cut line-param read ends on a whole line that endLine names, so
// offset:endLine+1 returns exactly the next line — no loss, no overlap — and
// walking to EOF reassembles the file.
test('project_read: a cut lineNumbers read ends on a whole line and offset:endLine+1 continues without loss', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await fs.writeFile(path.join(repoPath, 'big.txt'), BIG_LINES.join('\n') + '\n');
    const first = await callTool(ctx.baseUrl, 'project_read', { project: 'demo', relativePath: 'big.txt', lineNumbers: true });
    assert.ok(resultChars(first) <= MCP_RESULT_CHAR_BUDGET, `${resultChars(first)} chars`);
    const m = unwrap(first);
    assert.equal(m.truncated, true);
    assert.equal(m.startLine, 1);
    const served = m.content.split('\n');
    assert.equal(served.length, m.endLine, 'endLine names the last line served');
    assert.equal(served.at(-1), `${String(m.endLine).padStart(3)}\t${BIG_LINES[m.endLine - 1]}`, 'the last line is whole');

    const next = unwrap(await callTool(ctx.baseUrl, 'project_read', {
      project: 'demo', relativePath: 'big.txt', offset: m.endLine + 1, limit: 1,
    }));
    assert.equal(next.content, BIG_LINES[m.endLine]);

    // Walk the whole file as line-range reads (`limit` makes even the first page
    // one) by endLine+1: the pages tile it exactly.
    const got = [];
    let offset = 1;
    for (let guard = 0; guard < 20; guard++) {
      const r = await callTool(ctx.baseUrl, 'project_read', {
        project: 'demo', relativePath: 'big.txt', offset, limit: BIG_LINES.length,
      });
      assert.ok(resultChars(r) <= MCP_RESULT_CHAR_BUDGET, `${resultChars(r)} chars`);
      const p = unwrap(r);
      got.push(...p.content.replace(/\n$/, '').split('\n'));
      if (!p.truncated) break;
      offset = p.endLine + 1;
    }
    assert.deepEqual(got, BIG_LINES);
  } finally { await ctx.close(); }
});

// Invariant: a binary body's BASE64 stays within the budget (the 4/3 growth is
// accounted for), and the cut is flagged.
test('project_read: a 100 KB binary file comes back base64 within the budget, truncated', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    const bin = Buffer.alloc(100 * 1024, 7);
    bin[0] = 0; // a NUL in the probe window makes it binary
    await fs.writeFile(path.join(repoPath, 'blob.bin'), bin);
    const r = await callTool(ctx.baseUrl, 'project_read', { project: 'demo', relativePath: 'blob.bin' });
    assert.ok(resultChars(r) <= MCP_RESULT_CHAR_BUDGET, `${resultChars(r)} chars`);
    const m = unwrap(r);
    assert.equal(m.encoding, 'base64');
    assert.equal(m.truncated, true);
    assert.deepEqual(Buffer.from(m.content, 'base64'), bin.subarray(0, Buffer.from(m.content, 'base64').length),
      'the body is a prefix of the file');
  } finally { await ctx.close(); }
});

// Invariant: a line longer than the cap is the one mid-line cut, and it is
// never silent — the body carries an in-band marker with the line's full size
// and the metadata says lineTruncated, within the budget.
test('project_read: a first line longer than the cap is cut with a marker and lineTruncated', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    const longLine = 'L'.repeat(MCP_BODY_BUDGET + 5000);
    await fs.writeFile(path.join(repoPath, 'wide.txt'), `${longLine}\nsecond\n`);
    for (const args of [{ lineNumbers: true }, { offset: 1, limit: 2 }]) {
      const r = await callTool(ctx.baseUrl, 'project_read', { project: 'demo', relativePath: 'wide.txt', ...args });
      assert.ok(resultChars(r) <= MCP_RESULT_CHAR_BUDGET, `${JSON.stringify(args)}: ${resultChars(r)} chars`);
      const m = unwrap(r);
      assert.equal(m.lineTruncated, true, JSON.stringify(args));
      assert.equal(m.truncated, true);
      assert.equal(m.endLine, 1, 'the cut line is the one line served');
      assert.ok(m.content.endsWith(` … [line cut: ${longLine.length} bytes]`), `${JSON.stringify(args)}: ends ${JSON.stringify(m.content.slice(-60))}`);
    }
  } finally { await ctx.close(); }
});
