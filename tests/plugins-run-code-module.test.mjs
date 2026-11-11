// host.runCodeModule(id) (where a plugin's run_code members live) and
// host.runCodeMembers() (what enabled plugins declare), through the real plugin
// host over a temp projects root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPluginHost } from '../src/plugins/registry.ts';
import { makePluginRoot } from './plugin-helpers.mjs';

const run = promisify(execFile);
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

const MEMBER = {
  name: 'connect', description: 'Connect to a thing.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'], additionalProperties: false },
};
const manifest = (id, extra = {}) => ({ id, name: id, version: '1.0.0', pluginApi: 1, runCode: { module: 'run-code/index.mjs', members: [MEMBER] }, ...extra });
const okResult = (p, hasBackend = false) => ({ kind: 'ok', path: p, hasBackend, members: [{ name: 'connect', inputSchema: MEMBER.inputSchema }] });

async function addModulePlugin(env, project, m) {
  const dir = await env.addPluginProject(project, { manifest: m, withFixtureFiles: false });
  await fs.mkdir(path.join(dir, 'run-code'), { recursive: true });
  await fs.writeFile(path.join(dir, 'run-code', 'index.mjs'), 'export default () => ({});\n');
  return dir;
}

test('an enabled ok plugin resolves to its module in the main checkout; backend-less has hasBackend false', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const dir = await addModulePlugin(env, 'modplug', manifest('modplug'));
    await host.enable('modplug');
    assert.deepEqual(await host.runCodeModule('modplug'), okResult(path.join(dir, 'run-code', 'index.mjs')));
  } finally { await host.stopAll(); await env.restore(); }
});

test('hasBackend is true when the manifest declares a backend', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await addModulePlugin(env, 'bplug', manifest('bplug', { backend: { start: 'node server.mjs', healthPath: '/health' } }));
    await host.enable('bplug');
    const r = await host.runCodeModule('bplug');
    assert.equal(r.kind, 'ok');
    assert.equal(r.hasBackend, true);
  } finally { await host.stopAll(); await env.restore(); }
});

test('a worktree active version resolves the module inside that worktree', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const dir = await addModulePlugin(env, 'wtmod', manifest('wtmod'));
    await git(dir, 'init', '-q');
    await git(dir, 'config', 'user.email', 'test@test');
    await git(dir, 'config', 'user.name', 'test');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'plugin');
    const { createWorktree } = await import('../src/worktrees.ts');
    const meta = await createWorktree('wtmod');
    await host.enable('wtmod');
    await host.setActiveVersion('wtmod', { type: 'worktree', name: meta.worktreeName });
    assert.deepEqual(await host.runCodeModule('wtmod'), okResult(path.join(meta.worktreePath, 'run-code', 'index.mjs')));
  } finally { await host.stopAll(); await env.restore(); }
});

test('a disabled plugin is unknown with a reason, and re-enabling restores it (enabled is the store, not the row)', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await addModulePlugin(env, 'offplug', manifest('offplug'));
    const before = await host.runCodeModule('offplug');
    assert.equal(before.kind, 'unknown');
    assert.match(before.reason, /disabled/);
    await host.enable('offplug');
    assert.equal((await host.runCodeModule('offplug')).kind, 'ok');
    await host.disable('offplug');
    assert.equal((await host.runCodeModule('offplug')).kind, 'unknown');
  } finally { await host.stopAll(); await env.restore(); }
});

test('an invalid manifest (module file missing) is unknown and carries the manifest errors', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('badplug', { manifest: manifest('badplug'), withFixtureFiles: false });
    const r = await host.runCodeModule('badplug');
    assert.equal(r.kind, 'unknown');
    assert.match(r.reason, /invalid/);
    assert.match(r.reason, /runCode\.module 'run-code\/index\.mjs' not found/);
  } finally { await host.stopAll(); await env.restore(); }
});

test('an incompatible pluginApi is unknown', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('incplug', { manifest: manifest('incplug', { pluginApi: 99 }), withFixtureFiles: false });
    const r = await host.runCodeModule('incplug');
    assert.equal(r.kind, 'unknown');
    assert.match(r.reason, /incompatible/);
  } finally { await host.stopAll(); await env.restore(); }
});

test('duplicate id: the winner\'s module is served, never the losing project\'s', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const winner = await addModulePlugin(env, 'aaa', manifest('dupmod'));
    await addModulePlugin(env, 'zzz', manifest('dupmod'));
    await host.enable('dupmod');
    const r = await host.runCodeModule('dupmod');
    assert.equal(r.kind, 'ok');
    assert.equal(r.path, path.join(winner, 'run-code', 'index.mjs'));
  } finally { await host.stopAll(); await env.restore(); }
});

test('an unknown id, and a plugin declaring no runCode, are unknown with a reason', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('plain', { manifest: { id: 'plain', name: 'p', version: '1', pluginApi: 1 }, withFixtureFiles: false });
    await host.enable('plain');
    for (const id of ['plain', 'nope']) {
      const r = await host.runCodeModule(id);
      assert.equal(r.kind, 'unknown', id);
      assert.equal(typeof r.reason, 'string', id);
    }
  } finally { await host.stopAll(); await env.restore(); }
});

// PINS: runCodeMembers() lists exactly the enabled + ok plugins that declare runCode, members as declared;
// disabled, invalid and member-less plugins are absent; it follows enable/disable.
test('runCodeMembers() lists enabled ok plugins\' declared members only', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await addModulePlugin(env, 'on', manifest('onplug'));
    await addModulePlugin(env, 'off', manifest('offplug'));
    await env.addPluginProject('bad', { manifest: manifest('badplug'), withFixtureFiles: false });
    await env.addPluginProject('plain', { manifest: { id: 'plainplug', name: 'p', version: '1', pluginApi: 1 }, withFixtureFiles: false });
    await host.enable('onplug');
    await host.enable('plainplug');
    await host.init();
    assert.deepEqual(host.runCodeMembers(), [{ id: 'onplug', members: [MEMBER] }]);
    await host.disable('onplug');
    assert.deepEqual(host.runCodeMembers(), []);
  } finally { await host.stopAll(); await env.restore(); }
});
