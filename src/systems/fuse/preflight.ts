// Criterion 9: a host that cannot mount FUSE refuses the spawn, naming the
// reason. Called from Instance.launch() BEFORE spawn(), so the refusal reaches
// the caller as an HTTP/MCP error rather than as a dead subprocess whose stderr
// nobody is reading yet.
//
// ASSERT, NEVER INSTALL. Every probe here names the package that supplies what
// is missing and stops. Nothing in this module runs a package manager.
//
// The probes are injected rather than hard-wired so the refusal path can be
// tested with each dependency stubbed absent — the six messages are the
// deliverable, and a test that cannot make a dependency absent cannot pin them.

import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { httpError } from '../../httpError.ts';

export const FUSE_UNAVAILABLE = 'FUSE_UNAVAILABLE';

// The binaries the bootstrap chain needs, in the order it needs them.
export const REQUIRED_BINARIES = [
  'unshare', 'mount', 'umount', 'nsenter', 'chroot', 'setpriv', 'fusermount3',
] as const;

export interface PreflightProbes {
  // /dev/fuse exists AND is a character device.
  devFuseIsCharDevice(): Promise<boolean>;
  // `sudo -n true` exits 0 — uid 0 is reachable without a password prompt.
  sudoNonInteractive(): Promise<boolean>;
  // A binary resolvable on PATH.
  hasBinary(name: string): Promise<boolean>;
  // `fusectl` listed in /proc/filesystems.
  hasFusectl(): Promise<boolean>;
  // `pkg-config --exists fuse3` exits 0.
  hasFuse3Dev(): Promise<boolean>;
  // Compile-or-find the union binary; throws with gcc's stderr on failure.
  ensureBinary(): Promise<string>;
}

function refuse(detail: string): Error {
  return httpError(501, `FUSE_UNAVAILABLE: ${detail}`, { code: FUSE_UNAVAILABLE });
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 10_000 }, (err) => resolve(!err));
    child.on('error', () => resolve(false));
  });
}

export const realProbes: Omit<PreflightProbes, 'ensureBinary'> = {
  async devFuseIsCharDevice() {
    try { return (await fsp.stat('/dev/fuse')).isCharacterDevice(); }
    catch { return false; }
  },
  sudoNonInteractive() { return run('sudo', ['-n', 'true']); },
  hasBinary(name: string) { return run('sh', ['-c', `command -v ${name}`]); },
  async hasFusectl() {
    try { return /(^|\s)fusectl$/m.test(await fsp.readFile('/proc/filesystems', 'utf8')); }
    catch { return false; }
  },
  hasFuse3Dev() { return run('pkg-config', ['--exists', 'fuse3']); },
};

// Throws the FIRST failure, named. Order matters: each probe is cheaper and
// more fundamental than the one after it, so the message a host gets is the
// root cause rather than a downstream symptom.
export async function assertFuseAvailable(probes: PreflightProbes): Promise<void> {
  if (!(await probes.devFuseIsCharDevice())) {
    throw refuse('/dev/fuse is missing or is not a character device — this host cannot mount FUSE at all. Install the `fuse3` package and ensure the container is started with `--device /dev/fuse`.');
  }
  if (!(await probes.sudoNonInteractive())) {
    throw refuse('`sudo -n true` failed — cc needs passwordless uid 0 to enter a private mount namespace and mount the union. Grant NOPASSWD sudo to the user running cc.');
  }
  for (const bin of REQUIRED_BINARIES) {
    if (!(await probes.hasBinary(bin))) {
      throw refuse(`\`${bin}\` is not on PATH — the mount bootstrap cannot run without it. Install \`util-linux\`, \`coreutils\` and \`fuse3\`.`);
    }
  }
  if (!(await probes.hasFusectl())) {
    throw refuse('`fusectl` is not listed in /proc/filesystems — without it a wedged FUSE connection cannot be aborted, and teardown has no way to free a worker stuck on the mount. Load the kernel\'s fusectl support.');
  }
  if (!(await probes.hasBinary('gcc'))) {
    throw refuse('`gcc` is not on PATH — the union daemon is compiled from source on first use. Install `gcc`.');
  }
  if (!(await probes.hasFuse3Dev())) {
    throw refuse('`pkg-config --exists fuse3` failed — the union daemon is compiled on first use and needs libfuse3 headers. Install `libfuse3-dev` (and `pkg-config`).');
  }
  await probes.ensureBinary();
}
