// Install-time CLI, run by the installer with the bundled node:
//   node setup.mjs --install-dir D --bundle B --branch X --remote URL
// Ensures Git for Windows and claude, puts claude's dir on the user PATH,
// creates/fast-forwards the git checkout at <D>\app, and runs `npm ci`.
// Progress goes to stdout (the installer's details pane) and logs\setup.log.
// Any failure exits nonzero, which aborts the installer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { detectGit, detectClaude, launcherEnv, addToUserPath, getEnv } from './toolchain.mjs';

const w = path.win32;

export function makeLogger(logFile) {
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    if (logFile) fs.appendFileSync(logFile, line + '\n');
  };
}

// Spawn without a shell, stream output lines to `log`, resolve the exit code.
export function runLogged(log, file, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (buf) => {
      out += buf.toString();
      const lines = out.split(/\r?\n/);
      out = lines.pop();
      for (const l of lines) if (l.trim()) log(`  ${l}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (out.trim()) log(`  ${out}`);
      resolve(code ?? -1);
    });
  });
}

async function mustRun(log, file, args, opts) {
  const code = await runLogged(log, file, args, opts);
  if (code !== 0) throw new Error(`${path.basename(file)} ${args.slice(0, 2).join(' ')} failed (exit ${code})`);
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function ensureGit({ env, pin, log, fetchBuffer = download, run = runLogged }) {
  const found = detectGit(env);
  if (found) {
    log(`git: found ${found.gitExe}`);
    return found;
  }
  log(`git: not found (or lacks Git Bash); downloading Git for Windows ${pin.version}`);
  const buf = await fetchBuffer(pin.url);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== pin.sha256) throw new Error(`git installer sha256 mismatch: got ${sha}, pinned ${pin.sha256}`);
  log(`git: sha256 OK (${sha})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-'));
  const exe = path.join(dir, path.basename(new URL(pin.url).pathname));
  fs.writeFileSync(exe, buf);
  try {
    const code = await run(log, exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/CURRENTUSER', '/NOCANCEL', '/SP-', '/o:PathOption=Cmd']);
    if (code !== 0) throw new Error(`Git installer exited ${code}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const after = detectGit(env);
  if (!after) throw new Error('Git for Windows installed but git.exe with bin\\bash.exe was not found');
  log(`git: installed ${after.gitExe}`);
  return after;
}

export async function ensureClaude({ env, log, run = runLogged }) {
  const found = detectClaude(env);
  if (found) {
    log(`claude: found ${found.claudeExe}`);
    return found;
  }
  log('claude: not found; running the official installer (https://claude.ai/install.ps1)');
  const code = await run(log, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'irm https://claude.ai/install.ps1 | iex']);
  if (code !== 0) throw new Error(`claude installer exited ${code}`);
  const home = getEnv(env, 'USERPROFILE');
  const claudeExe = w.join(home, '.local', 'bin', 'claude.exe');
  if (!fs.existsSync(claudeExe)) throw new Error(`claude installer finished but ${claudeExe} does not exist`);
  log(`claude: installed ${claudeExe}`);
  return { claudeExe, dir: w.dirname(claudeExe) };
}

const gitOut = (git, cwd, args) => new Promise((resolve) => {
  const c = spawn(git, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  c.stdout.on('data', (d) => { stdout += d; });
  c.on('close', (code) => resolve({ code: code ?? -1, stdout: stdout.trim() }));
});

// Fresh install: clone from the bundle (LF, branch + upstream set), then
// point origin at the real remote. Existing checkout: fast-forward to the
// bundle's tip, never downgrade or clobber.
export async function checkout({ git, bundle, dir, branch, remoteUrl, log, env }) {
  const g = (args, cwd = dir) => mustRun(log, git, args, { cwd, env });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      throw new Error(`${dir} exists, is not a git checkout and is not empty`);
    }
    log(`checkout: cloning ${branch} from the bundle into ${dir}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await mustRun(log, git, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', '--branch', branch, bundle, dir], { env });
  } else {
    log(`checkout: existing checkout at ${dir}`);
    await g(['fetch', bundle, branch]);
    const same = await gitOut(git, dir, ['rev-parse', 'HEAD', 'FETCH_HEAD']);
    const [head, tip] = same.stdout.split('\n');
    if (head === tip) {
      log('checkout: already at the installer\'s commit');
    } else if ((await runLogged(log, git, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], { cwd: dir, env })) === 0) {
      log(`checkout: fast-forwarding ${head.slice(0, 8)} -> ${tip.slice(0, 8)}`);
      await g(['merge', '--ff-only', 'FETCH_HEAD']);
    } else {
      log(`checkout: kept ${head.slice(0, 8)}; it is at or ahead of the installer's commit ${tip.slice(0, 8)}`);
    }
  }
  await g(['config', 'core.autocrlf', 'false']);
  await g(['remote', 'set-url', 'origin', remoteUrl]);
}

export async function main(argv, env = process.env) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['install-dir', 'bundle', 'branch', 'remote']) {
    if (!args[k]) throw new Error(`missing --${k}`);
  }
  const installDir = args['install-dir'];
  const log = makeLogger(path.join(installDir, 'logs', 'setup.log'));
  const pins = JSON.parse(fs.readFileSync(new URL('./pins.json', import.meta.url), 'utf8'));

  const git = await ensureGit({ env, pin: pins.git, log });
  const claude = await ensureClaude({ env, log });
  const home = getEnv(env, 'USERPROFILE');
  if (home && claude.dir.toLowerCase() === w.join(home, '.local', 'bin').toLowerCase()) {
    const added = await addToUserPath(claude.dir, {
      reg: (a) => new Promise((resolve) => {
        const c = spawn('reg.exe', a, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        c.stdout.on('data', (d) => { stdout += d; });
        c.on('close', (code) => resolve({ code: code ?? -1, stdout }));
      }),
      env,
    });
    log(added ? `path: added ${claude.dir} to the user PATH` : `path: ${claude.dir} already on the user PATH`);
  }

  const appDir = path.join(installDir, 'app');
  const serverEnv = launcherEnv({ env, installDir, git, claude });
  await checkout({ git: git.gitExe, bundle: args.bundle, dir: appDir, branch: args.branch, remoteUrl: args.remote, log, env: serverEnv });

  log('npm: npm ci');
  const npmCli = path.join(installDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mustRun(log, path.join(installDir, 'node', 'node.exe'), [npmCli, 'ci'], { cwd: appDir, env: serverEnv });
  log('setup complete');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`setup failed: ${e.message}`);
    try { fs.appendFileSync(path.join(process.argv[process.argv.indexOf('--install-dir') + 1], 'logs', 'setup.log'), `setup failed: ${e.stack}\n`); } catch {}
    process.exit(1);
  });
}
