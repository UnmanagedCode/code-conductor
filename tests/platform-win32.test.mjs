// win32Platform's logic with injected env / fs / exec, so it runs on any host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWin32Platform, resolveGitBash, taskkillArgv } from '../src/platform/win32.ts';
import { win32Platform } from '../src/platform/index.ts';

const GIT = 'C:\\Program Files\\Git';
const BASH = `${GIT}\\bin\\bash.exe`;
const existsIn = (...files) => (p) => files.includes(p);

function plat({ env = {}, files = [], exec = () => {}, realpathNative = (p) => p, realpathJs = (p) => p } = {}) {
  return createWin32Platform({ env, exists: existsIn(...files), execFileSync: exec, realpathNative, realpathJs });
}

test('resolveGitBash: tiers win in order', () => {
  const all = ['X:\\own\\bash.exe', `${GIT}\\cmd\\git.exe`, BASH, 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'];
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'X:\\own\\bash.exe', PATH: `${GIT}\\cmd`, LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
  assert.equal(resolveGitBash(env, existsIn(...all)), 'X:\\own\\bash.exe');
  assert.equal(resolveGitBash({ ...env, CLAUDE_CODE_GIT_BASH_PATH: undefined }, existsIn(...all)), BASH, 'PATH git.exe → ..\\bin\\bash.exe');
  assert.equal(resolveGitBash({ ...env, CLAUDE_CODE_GIT_BASH_PATH: undefined, PATH: '' }, existsIn(...all)), 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  assert.equal(resolveGitBash({ ProgramFiles: 'C:\\Program Files' }, existsIn(BASH)), BASH);
});

test('resolveGitBash: Path spelling, Git\\bin on PATH, and the failure lists every candidate', () => {
  assert.equal(resolveGitBash({ Path: `C:\\x;${GIT}\\cmd` }, existsIn(`${GIT}\\cmd\\git.exe`, BASH)), BASH);
  assert.equal(resolveGitBash({ PATH: `${GIT}\\bin` }, existsIn(`${GIT}\\bin\\git.exe`, BASH)), BASH);
  assert.throws(
    () => resolveGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'Z:\\b.exe', PATH: `${GIT}\\cmd`, ProgramFiles: 'C:\\Program Files' }, existsIn(`${GIT}\\cmd\\git.exe`)),
    (e) => /Git for Windows' bash\.exe not found/.test(e.message)
      && e.message.includes('Z:\\b.exe') && e.message.includes(`${GIT}\\bin\\bash.exe`) && e.message.includes(`${GIT}\\cmd\\bash.exe`));
});

test('commandFor: shell is bash -lc; bash/sh/env map into Git; others pass through', () => {
  const p = plat({ env: { CLAUDE_CODE_GIT_BASH_PATH: BASH }, files: [BASH] });
  assert.deepEqual(p.commandFor({ shell: 'a && b' }), { command: BASH, args: ['-lc', 'a && b'] });
  assert.deepEqual(p.commandFor({ argv: ['bash', 'x.sh'] }), { command: BASH, args: ['x.sh'] });
  assert.deepEqual(p.commandFor({ argv: ['sh', '-c', 'x'] }), { command: `${GIT}\\bin\\sh.exe`, args: ['-c', 'x'] });
  assert.deepEqual(p.commandFor({ argv: ['env', 'A=1'] }), { command: `${GIT}\\usr\\bin\\env.exe`, args: ['A=1'] });
  assert.deepEqual(p.commandFor({ argv: ['env', 'A=1', 'B=2', 'bash', 'x'] }), { command: `${GIT}\\usr\\bin\\env.exe`, args: ['A=1', 'B=2', BASH, 'x'] });
  assert.deepEqual(p.commandFor({ argv: ['git', 'status'] }), { command: 'git', args: ['status'] });
});

test('commandFor throws only when the mapping needs bash and it is unresolved; success is memoised, failure is not', () => {
  const files = [];
  const p = createWin32Platform({ env: { ProgramFiles: 'C:\\Program Files' }, exists: (f) => files.includes(f), execFileSync() {}, realpathNative: (x) => x, realpathJs: (x) => x });
  assert.deepEqual(p.commandFor({ argv: ['git', 'log'] }), { command: 'git', args: ['log'] });
  assert.throws(() => p.commandFor({ shell: 'true' }), /bash\.exe not found/);
  files.push(BASH);
  assert.equal(p.commandFor({ shell: 'true' }).command, BASH, 'installing Git later takes effect');
  files.length = 0;
  assert.equal(p.commandFor({ shell: 'true' }).command, BASH, 'memoised');
});

test('splitCommand: quotes group, backslashes are literal, empty tokens drop', () => {
  assert.deepEqual(win32Platform.splitCommand('"C:\\Program Files\\x\\claude.exe" --flag'), ['C:\\Program Files\\x\\claude.exe', '--flag']);
  assert.deepEqual(win32Platform.splitCommand('a\t""  b'), ['a', 'b']);
  assert.deepEqual(win32Platform.splitCommand('   '), []);
  assert.deepEqual(win32Platform.splitCommand(''), []);
});

test('pathKey: separators, trailing slash, drive root and case', () => {
  assert.equal(win32Platform.pathKey('C:/A/b/'), 'c:\\a\\b');
  assert.equal(win32Platform.pathKey('C:\\'), 'c:\\');
  assert.equal(win32Platform.pathKey('c:/'), 'c:\\');
  assert.equal(win32Platform.pathKey('\\\\?\\C:\\'), 'c:\\', 'extended-length drive root');
  assert.equal(win32Platform.pathKey('\\\\?\\C:\\Users\\X'), win32Platform.pathKey('c:/users/x/'));
  assert.equal(win32Platform.pathKey('\\\\?\\UNC\\srv\\share'), '\\\\?\\unc\\srv\\share', 'UNC keeps its prefix');
});

test('pathKey pins createProject\'s git-dir check (samePath): git\'s C:/…/.git equals path.join(real, ".git")', () => {
  const same = (a, b) => win32Platform.pathKey(a) === win32Platform.pathKey(b);
  assert.equal(same('C:/Users/Me/Proj/.git', path.win32.join('c:\\users\\me\\proj', '.git')), true);
  assert.equal(same('C:/Users/Me/Other/.git', path.win32.join('C:\\Users\\Me\\Proj', '.git')), false);
});

test('taskkillArgv: absolute path under SystemRoot, falling back to C:\\Windows', () => {
  assert.deepEqual(taskkillArgv(42, { SystemRoot: 'D:\\Win' }), ['D:\\Win\\System32\\taskkill.exe', ['/T', '/F', '/PID', '42']]);
  assert.equal(taskkillArgv(42, {})[0], 'C:\\Windows\\System32\\taskkill.exe');
});

test('killGroup tree-kills and throws ESRCH on exit 128; killProcess falls back to the handle', () => {
  const seen = [];
  const exit = (status) => () => { throw Object.assign(new Error('x'), { status }); };
  const gone = plat({ exec: exit(128) });
  assert.throws(() => gone.killGroup(7, 'SIGTERM'), (e) => e.code === 'ESRCH');
  const ok = plat({ exec: (f, a, o) => { seen.push([f, a, o]); } });
  ok.killGroup(7, 'SIGKILL');
  assert.deepEqual(seen[0][1], ['/T', '/F', '/PID', '7']);
  assert.deepEqual(seen[0][2], { windowsHide: true, timeout: 5000, stdio: 'ignore' });

  const denied = plat({ exec: exit(1) });
  const sigs = [];
  denied.killProcess({ pid: 9, kill: (s) => sigs.push(s) }, 'SIGKILL');
  denied.killProcess({ pid: null, kill: (s) => sigs.push(`null:${s}`) }, 'SIGTERM');
  assert.deepEqual(sigs, ['SIGKILL', 'null:SIGTERM']);
  assert.throws(() => gone.killProcess(7, 'SIGKILL'), (e) => e.code === 'ESRCH');
});

test('spawnOptions per role: only daemon is detached, all hide the window', () => {
  assert.deepEqual(win32Platform.spawnOptions('child'), { windowsHide: true });
  assert.deepEqual(win32Platform.spawnOptions('group'), { windowsHide: true });
  assert.deepEqual(win32Platform.spawnOptions('daemon'), { detached: true, windowsHide: true });
});

test('capabilities are all off; SIGTERM is not soft', () => {
  assert.deepEqual(win32Platform.capabilities, { remoteSystems: false, fuseUnion: false, voice: false });
  assert.equal(win32Platform.softSigterm, false);
});

test('cliEnv: {} when the operator set it or Git is unresolved; the resolved path otherwise', () => {
  assert.deepEqual(plat({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'Q:\\b.exe' } }).cliEnv(), {});
  assert.deepEqual(plat({ env: {} }).cliEnv(), {});
  assert.deepEqual(plat({ env: { PATH: `${GIT}\\cmd` }, files: [`${GIT}\\cmd\\git.exe`, BASH] }).cliEnv(), { CLAUDE_CODE_GIT_BASH_PATH: BASH });
});

test('canonicalPath: native, then native(js) for a junction, then null', () => {
  const boom = () => { throw new Error('UNKNOWN'); };
  assert.equal(plat({ realpathNative: () => 'C:\\Real' }).canonicalPath('c:\\real'), 'C:\\Real');
  assert.equal(plat({
    realpathNative: (p) => { if (p === 'C:\\junction') throw new Error('UNKNOWN'); return p.toUpperCase(); },
    realpathJs: () => 'c:\\target',
  }).canonicalPath('C:\\junction'), 'C:\\TARGET');
  assert.equal(plat({ realpathNative: boom, realpathJs: boom }).canonicalPath('c:\\gone'), null);
});
