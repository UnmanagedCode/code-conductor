import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPluginLibrary } from '../src/plugins/library.js';
import { orchStoreRoot } from '../src/projects.js';
import { makePluginRoot } from './plugin-helpers.mjs';

const run = promisify(execFile);
async function git(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

async function rejectsWithStatus(promise, statusCode) {
  try { await promise; }
  catch (e) { assert.equal(e.statusCode, statusCode, `expected ${statusCode}, got ${e.statusCode}: ${e.message}`); return e; }
  assert.fail(`expected rejection with statusCode ${statusCode}`);
}

function libraryDir() {
  return path.join(orchStoreRoot(), 'plugins', 'library');
}

async function dropLibraryEntry(name, entry) {
  const dir = libraryDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(entry));
}

test('list(): default code-share entry present with no library dir', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    const rows = await lib.list();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, 'code-share');
    assert.equal(rows[0].repo, 'https://github.com/UnmanagedCode/code-share');
    assert.equal(rows[0].installed, false);
    assert.equal(rows[0].installedAs, null);
  } finally {
    await env.restore();
  }
});

test('list(): code-playwright is a built-in entry alongside code-share, with its postClone/postPull command', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    const rows = await lib.list();
    const ids = rows.map(r => r.id).sort();
    assert.deepEqual(ids, ['code-hub', 'code-playwright', 'code-share']);
    const cp = rows.find(r => r.id === 'code-playwright');
    assert.equal(cp.repo, 'https://github.com/UnmanagedCode/code-playwright');
    assert.equal(cp.postClone, 'bash install.sh');
    assert.equal(cp.postPull, 'bash install.sh');
    const cs = rows.find(r => r.id === 'code-share');
    assert.equal(cs.postClone, undefined, 'code-share has no post-hook by default');
  } finally {
    await env.restore();
  }
});

test('list(): a dropped file adds an entry; malformed files are skipped, not fatal', async () => {
  const env = await makePluginRoot();
  try {
    await dropLibraryEntry('extra.json', { id: 'extra-plugin', name: 'Extra', description: 'desc', repo: 'https://example.com/org/extra' });
    await fs.mkdir(libraryDir(), { recursive: true });
    await fs.writeFile(path.join(libraryDir(), 'broken.json'), '{ not json'); // truly malformed, not a stringified string
    await dropLibraryEntry('incomplete.json', { id: 'nope' }); // missing name/repo
    await fs.writeFile(path.join(libraryDir(), 'not-a-manifest.txt'), 'ignored, wrong extension');

    const lib = createPluginLibrary();
    const rows = await lib.list();
    const ids = rows.map(r => r.id).sort();
    assert.deepEqual(ids, ['code-hub', 'code-playwright', 'code-share', 'extra-plugin']);
  } finally {
    await env.restore();
  }
});

test('list(): a dropped file whose id matches the built-in overrides it', async () => {
  const env = await makePluginRoot();
  try {
    await dropLibraryEntry('code-share.json', { id: 'code-share', name: 'Custom Code Share', repo: 'https://example.com/fork/code-share' });
    const lib = createPluginLibrary();
    const rows = await lib.list();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, 'Custom Code Share');
    assert.equal(rows[0].repo, 'https://example.com/fork/code-share');
  } finally {
    await env.restore();
  }
});

test('list(): installed flips true once the derived target dir exists', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-share');
    const lib = createPluginLibrary();
    const rows = await lib.list();
    assert.equal(rows[0].installed, true);
    assert.equal(rows[0].installedAs, 'code-share');
  } finally {
    await env.restore();
  }
});

test('install(): unknown id -> 404', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.install('nope'), 404);
  } finally {
    await env.restore();
  }
});

test('install(): invalid/disallowed repo URL scheme -> 400', async () => {
  const env = await makePluginRoot();
  try {
    await dropLibraryEntry('bad.json', { id: 'bad', name: 'Bad', repo: 'ftp://example.com/org/bad' });
    await dropLibraryEntry('worse.json', { id: 'worse', name: 'Worse', repo: 'not a url at all' });
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.install('bad'), 400);
    await rejectsWithStatus(lib.install('worse'), 400);
  } finally {
    await env.restore();
  }
});

test('install(): already-installed target dir -> 409', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-share');
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.install('code-share'), 409);
  } finally {
    await env.restore();
  }
});

test('install(): happy path clones (fake impl) and triggers a rescan, never enabling', async () => {
  const env = await makePluginRoot();
  try {
    let rescanned = 0;
    const stubHost = { rescan: async () => { rescanned++; } };
    const cloneCalls = [];
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _cloneImpl: async (url, destDir) => {
        cloneCalls.push({ url, destDir });
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(path.join(destDir, 'marker.txt'), 'cloned');
        return { code: 0, stdout: 'Cloning...', stderr: '' };
      },
    });
    const result = await lib.install('code-share');
    assert.equal(result.name, 'code-share');
    assert.equal(cloneCalls.length, 1);
    assert.equal(cloneCalls[0].url, 'https://github.com/UnmanagedCode/code-share');
    assert.ok((await fs.stat(path.join(env.root, 'code-share'))).isDirectory());
    assert.equal(rescanned, 1);
    assert.equal(result.postClone, null, 'code-share has no postClone configured');

    const rows = await lib.list();
    assert.equal(rows[0].installed, true);
  } finally {
    await env.restore();
  }
});

test('install(): clone failure -> 502 with stderr tail, partial dir cleaned up', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true }); // partial clone leaves a dir behind
        return { code: 128, stdout: '', stderr: 'fatal: could not read from remote repository\nboom' };
      },
    });
    const e = await rejectsWithStatus(lib.install('code-share'), 502);
    assert.match(e.tail, /boom/);
    await assert.rejects(fs.stat(path.join(env.root, 'code-share')), { code: 'ENOENT' });
  } finally {
    await env.restore();
  }
});

test('install(): runs postClone after a successful clone + rescan', async () => {
  const env = await makePluginRoot();
  try {
    let rescanned = 0;
    const stubHost = { rescan: async () => { rescanned++; } };
    const hookCalls = [];
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
      _runHookImpl: async (command, cwd) => {
        hookCalls.push({ command, cwd });
        return { code: 0, output: 'deps installed' };
      },
    });
    const result = await lib.install('code-playwright');
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].command, 'bash install.sh');
    assert.equal(hookCalls[0].cwd, path.join(env.root, 'code-playwright'));
    assert.deepEqual(result.postClone, { ran: true, ok: true, code: 0, tail: 'deps installed' });
    assert.equal(rescanned, 1, 'rescan happens before postClone, per the documented order');
  } finally {
    await env.restore();
  }
});

test('install(): postClone failure keeps the clone on disk and resolves (not rejects) with ok:false + tail', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
      _runHookImpl: async () => ({ code: 1, output: 'npm ERR! network timeout' }),
    });
    const result = await lib.install('code-playwright');
    assert.equal(result.postClone.ran, true);
    assert.equal(result.postClone.ok, false);
    assert.equal(result.postClone.code, 1);
    assert.match(result.postClone.tail, /network timeout/);
    assert.ok((await fs.stat(path.join(env.root, 'code-playwright'))).isDirectory(), 'clone was NOT removed');
  } finally {
    await env.restore();
  }
});

test('update(): unknown library id -> 404', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.update('nope'), 404);
  } finally {
    await env.restore();
  }
});

test('update(): not installed -> 404', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.update('code-share'), 404);
  } finally {
    await env.restore();
  }
});

test('update(): pull failure (not a git repo) -> 502 with tail; postPull never runs', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-share'); // plain dir, not a git repo
    const hookCalls = [];
    const lib = createPluginLibrary({
      _runHookImpl: async (command, cwd) => { hookCalls.push({ command, cwd }); return { code: 0, output: '' }; },
    });
    const e = await rejectsWithStatus(lib.update('code-share'), 502);
    assert.match(e.tail, /not a git repository/i);
    assert.equal(hookCalls.length, 0);
  } finally {
    await env.restore();
  }
});

test('update(): pulls new commits, runs postPull, and triggers a rescan', async () => {
  const env = await makePluginRoot();
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-remote-'));
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-seed-'));
  try {
    await git(remoteDir, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
    await git(seedDir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(seedDir, 'config', 'user.email', 'test@test');
    await git(seedDir, 'config', 'user.name', 'test');
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v1');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v1');
    await git(seedDir, 'remote', 'add', 'origin', remoteDir);
    await git(seedDir, 'push', '-q', 'origin', 'main');

    await git(env.root, 'clone', '-q', remoteDir, 'code-x');

    // A new commit lands upstream after the install-time clone.
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v2');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v2');
    await git(seedDir, 'push', '-q', 'origin', 'main');

    await dropLibraryEntry('code-x.json', {
      id: 'code-x', name: 'Code X', repo: 'https://example.com/org/code-x', postPull: 'echo hi',
    });

    let rescanned = 0;
    const stubHost = { rescan: async () => { rescanned++; } };
    const hookCalls = [];
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _runHookImpl: async (command, cwd) => { hookCalls.push({ command, cwd }); return { code: 0, output: 'ran' }; },
    });

    const result = await lib.update('code-x');
    assert.equal(result.name, 'code-x');
    assert.deepEqual(result.postPull, { ran: true, ok: true, code: 0, tail: 'ran' });
    assert.equal(rescanned, 1);
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].command, 'echo hi');
    assert.equal(hookCalls[0].cwd, path.join(env.root, 'code-x'));

    const content = await fs.readFile(path.join(env.root, 'code-x', 'file.txt'), 'utf8');
    assert.equal(content, 'v2', 'pull actually fast-forwarded');
  } finally {
    await env.restore();
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(seedDir, { recursive: true, force: true });
  }
});
