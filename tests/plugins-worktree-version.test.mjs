// Worktree-version activation: activeVersion drives the supervisor cwd,
// the manifest is re-read from the active checkout on every start, and a
// checkout that isn't this plugin is refused with the previous state kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPluginHost } from '../src/plugins/registry.js';
import { makePluginRoot } from './plugin-helpers.mjs';

const run = promisify(execFile);

const MANIFEST = {
  id: 'wtplug', name: 'WT Plug', version: '1.0.0', pluginApi: 1,
  backend: { start: 'node server.mjs', healthPath: '/health' },
};

async function git(cwd, ...args) {
  await run('git', ['-C', cwd, ...args]);
}

// A git-repo plugin project + one worktree whose server identifies itself
// differently — the response proves which checkout the child runs from.
async function setup(env) {
  const dir = await env.addPluginProject('wtplug', { manifest: MANIFEST });
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 'test@test');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'plugin main');

  const { createWorktree } = await import('../src/worktrees.js');
  const meta = await createWorktree('wtplug');
  const serverPath = path.join(meta.worktreePath, 'server.mjs');
  const src = await fs.readFile(serverPath, 'utf8');
  await fs.writeFile(serverPath, src.replace("plugin: 'fake-plugin'", "plugin: 'from-worktree'"));
  await git(meta.worktreePath, 'commit', '-qam', 'worktree marker');
  return { dir, meta };
}

async function healthPlugin(host) {
  const { port } = host.runtimeInfo('wtplug');
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  return (await r.json()).plugin;
}

test('switching to a worktree restarts from that checkout (and back)', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const { meta } = await setup(env);
    await host.enable('wtplug');
    await host.start('wtplug');
    assert.equal(await healthPlugin(host), 'fake-plugin');
    const mainHead = (await host.status('wtplug')).gitHead;
    assert.match(mainHead, /^[0-9a-f]{40}$/);

    // Switch while running → child restarts from the worktree checkout.
    const row = await host.setActiveVersion('wtplug', { type: 'worktree', name: meta.worktreeName });
    assert.deepEqual(row.activeVersion, { type: 'worktree', name: meta.worktreeName });
    assert.equal(row.state, 'ready');
    assert.equal(await healthPlugin(host), 'from-worktree');
    assert.match(row.gitHead, /^[0-9a-f]{40}$/);
    assert.notEqual(row.gitHead, mainHead, 'worktree HEAD differs (marker commit)');

    // And back to main.
    const back = await host.setActiveVersion('wtplug', { type: 'main' });
    assert.equal(back.state, 'ready');
    assert.equal(await healthPlugin(host), 'fake-plugin');
    assert.equal(back.gitHead, mainHead);
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('a checkout that is not this plugin is refused; previous state kept', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const { meta } = await setup(env);
    await host.enable('wtplug');
    await host.start('wtplug');

    // The worktree stops being this plugin.
    await fs.writeFile(path.join(meta.worktreePath, 'conductor.plugin.json'),
      JSON.stringify({ ...MANIFEST, id: 'other-plugin' }));
    await assert.rejects(
      host.setActiveVersion('wtplug', { type: 'worktree', name: meta.worktreeName }),
      (e) => e.statusCode === 400 && /does not match/.test(e.message),
    );
    const row = await host.status('wtplug');
    assert.deepEqual(row.activeVersion, { type: 'main' }, 'activeVersion unchanged');
    assert.equal(row.state, 'ready', 'child kept running from main');
    assert.equal(await healthPlugin(host), 'fake-plugin');

    // Invalid manifest in the worktree → same refusal.
    await fs.writeFile(path.join(meta.worktreePath, 'conductor.plugin.json'), '{broken');
    await assert.rejects(
      host.setActiveVersion('wtplug', { type: 'worktree', name: meta.worktreeName }),
      (e) => e.statusCode === 400,
    );
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('switch while stopped does not start; the next start uses the new cwd', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const { meta } = await setup(env);
    await host.enable('wtplug');
    const row = await host.setActiveVersion('wtplug', { type: 'worktree', name: meta.worktreeName });
    assert.equal(row.state, 'stopped', 'switching a stopped plugin does not start it');
    await host.start('wtplug');
    assert.equal(await healthPlugin(host), 'from-worktree');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('bootstrap: worktree-only plugin starts from its worktree; switch-to-main gated on a main manifest', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    // Main checkout: fixture files but NO manifest (first-time plugin-ification
    // — the manifest exists only in an unmerged worktree).
    const dir = await env.addPluginProject('wtplug');
    await fs.rm(path.join(dir, 'conductor.plugin.json'));
    await git(dir, 'init', '-q');
    await git(dir, 'config', 'user.email', 'test@test');
    await git(dir, 'config', 'user.name', 'test');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'no manifest yet');
    const { createWorktree } = await import('../src/worktrees.js');
    const meta = await createWorktree('wtplug');
    await fs.writeFile(path.join(meta.worktreePath, 'conductor.plugin.json'), JSON.stringify(MANIFEST));

    const rows = await host.rescan();
    const row = rows.find(r => r.id === 'wtplug');
    assert.equal(row.state, 'discovered');
    assert.deepEqual(row.manifestSource, { type: 'worktree', name: meta.worktreeName });

    const en = await host.enable('wtplug');
    assert.deepEqual(en.activeVersion, { type: 'worktree', name: meta.worktreeName });
    await host.start('wtplug'); // succeeds ⇒ cwd is the worktree (main has no manifest to start from)
    assert.equal(await healthPlugin(host), 'fake-plugin');

    // Main still has no manifest → switching to main is refused.
    await assert.rejects(
      host.setActiveVersion('wtplug', { type: 'main' }),
      (e) => e.statusCode === 400 && /no conductor\.plugin\.json/.test(e.message),
    );
    assert.equal((await host.status('wtplug')).state, 'ready', 'refusal kept the child running');

    // Once main gains the manifest (worktree merged), main becomes switchable
    // — and discovery flips back to main-sourced.
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(MANIFEST));
    await host.rescan();
    const back = await host.setActiveVersion('wtplug', { type: 'main' });
    assert.deepEqual(back.activeVersion, { type: 'main' });
    assert.equal(back.state, 'ready');
    assert.deepEqual(back.manifestSource, { type: 'main' });
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('version guards: unknown worktree 404, bad shape 400, no registry entry 409', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await setup(env);
    await assert.rejects(host.setActiveVersion('wtplug', { type: 'main' }), (e) => e.statusCode === 409);
    await host.enable('wtplug');
    await assert.rejects(host.setActiveVersion('wtplug', { type: 'worktree', name: 'nope' }), (e) => e.statusCode === 404);
    await assert.rejects(host.setActiveVersion('wtplug', { type: 'branch' }), (e) => e.statusCode === 400);
    await assert.rejects(host.setActiveVersion('wtplug', { type: 'worktree' }), (e) => e.statusCode === 400);
  } finally {
    await env.restore();
  }
});
