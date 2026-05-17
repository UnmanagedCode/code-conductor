import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.mjs');

export async function makeTmpHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-'));
  await fs.mkdir(path.join(dir, 'project'), { recursive: true });
  await fs.mkdir(path.join(dir, '.claude', 'projects'), { recursive: true });
  return dir;
}

export async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

export async function bootServer({ scenarioPath, useRealClaude = false } = {}) {
  const tmpHome = await makeTmpHome();
  const projectsRoot = path.join(tmpHome, 'project');
  const claudeProjectsRoot = path.join(tmpHome, '.claude', 'projects');

  const prev = {
    PROJECTS_ROOT: process.env.PROJECTS_ROOT,
    CLAUDE_PROJECTS_ROOT: process.env.CLAUDE_PROJECTS_ROOT,
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    FAKE_CLAUDE_SCENARIO: process.env.FAKE_CLAUDE_SCENARIO,
  };
  process.env.PROJECTS_ROOT = projectsRoot;
  process.env.CLAUDE_PROJECTS_ROOT = claudeProjectsRoot;
  if (useRealClaude) {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_SCENARIO;
  } else {
    process.env.CLAUDE_BIN = `${process.execPath} ${FAKE_CLAUDE}`;
    if (scenarioPath) process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
    else delete process.env.FAKE_CLAUDE_SCENARIO;
  }

  const { server, instances } = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  // Mirror server.js's start() flow — instances need the bound port to
  // construct the PreToolUse http hook callback URL.
  if (instances) instances.setServerPort(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  async function close() {
    if (instances && typeof instances.shutdown === 'function') await instances.shutdown();
    await new Promise(r => server.close(r));
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rmrf(tmpHome);
  }

  return { baseUrl, wsUrl, server, instances, tmpHome, projectsRoot, claudeProjectsRoot, close };
}

export async function api(baseUrl, method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

export async function waitFor(predicate, { timeout = 4000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = await predicate(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor: timeout');
    await new Promise(r => setTimeout(r, interval));
  }
}
