// The command-spec transforms behind `ExecOptions.stdin` (a Buffer) and
// `ExecOptions.envOverlay` — pure string building, no I/O, shared by both
// implementations of `exec`.
//
// WHY A WRAPPER AT ALL. The wire has no frame that carries bytes INTO an exec
// and cc never sends a frame `env` (src/systems/providerSystem.ts's header), so
// on a provider System both options have to ride inside the command itself:
//   * stdin is staged as a file on the target and the wrapper opens it onto
//     fd 0, then unlinks it BEFORE the real command starts — its bytes live on
//     through the open descriptor, so a timeout or a kill cannot strand it;
//   * an overlay is `env(1)` in argv, or `export` lines in a shell string, which
//     ADD to the target's environment where a frame `env` would replace it.
// Locally stdin is a native pipe and an argv overlay is a plain env merge; the
// shell form takes the same `export` prelude on both sides so a login profile
// cannot override the caller's values on either.
//
// THE ARGV WRAPPER REPLACES ITSELF (`exec "$@"`), so the process a timeout or a
// kill signals is the caller's command, and its group is the command's group.
// What the wrapper cannot replace is spawn's own "could not start" answer: run
// under `sh`, a missing binary would be exit 127 from a shell that DID start.
// So it pre-checks argv[0] the way spawn resolves it and reports a failure as
// one `<nonce> <ERRNO>` line on stderr, which `unwrapResult` turns back into a
// never-started result. The nonce is per call and random, so a command's own
// output cannot be mistaken for that line.

import type { ExecResult } from './system.ts';
import { isSystemErrorCode } from './protocol.ts';

// A POSIX shell variable name — the only names `export` and `env(1)` agree on.
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Single-quote a string for interpolation into a POSIX shell command.
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// An overlay reaching a System is cc's own responsibility to have validated
// (the REST route refuses a bad one first), so a violation here throws.
export function assertEnvOverlay(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`exec: envOverlay name ${JSON.stringify(name)} does not match ${ENV_NAME_RE}`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`exec: envOverlay value for ${name} must be a string without NUL`);
    }
  }
}

// Exit codes the wrappers report their own failures with. 127 is what a shell
// reports for a command it cannot find; 125 is outside the range a command and
// timeout(1) use for themselves.
const EXIT_NOT_STARTED = 127;
const EXIT_NO_STDIN = 125;

export interface WrapOptions {
  envOverlay?: Record<string, string>;
  // The staged stdin file on the target; absent when there is none to open.
  stdinPath?: string;
  nonce?: string;
}

// `<prelude>\n<cmd>` for a shell-form command. The prelude runs after the login
// profile `bash -lc` sources, so the caller's values win over it.
export function shellWithPrelude(cmd: string, { envOverlay, stdinPath, nonce }: WrapOptions): string {
  const lines = Object.entries(envOverlay ?? {}).map(([k, v]) => `export ${k}=${shQuote(v)}`);
  if (stdinPath !== undefined) {
    if (nonce === undefined) throw new Error('shellWithPrelude: a stdinPath needs a nonce');
    const f = shQuote(stdinPath);
    // `[ -r ]` FIRST: a failed `exec <` redirection makes dash exit on the
    // spot, before an `||` could report it.
    lines.push(
      `if [ -r ${f} ] && exec <${f}; then rm -f -- ${f}; else printf '%s ESTDIN\\n' ${shQuote(nonce)} >&2; exit ${EXIT_NO_STDIN}; fi`,
    );
  }
  return lines.length === 0 ? cmd : `${lines.join('\n')}\n${cmd}`;
}

// Positional parameters: $1 the nonce, $2 the staged stdin path or '', then the
// caller's argv. The nonce is an argument rather than a variable so it never
// reaches the command's environment.
//
// The bare-name check walks PATH itself rather than asking `command -v`, which
// answers a shell BUILTIN's name (`echo`, `true`, `printf`) — spawn never runs
// a builtin, it finds the binary. It mirrors execvp, as local spawn does
// (measured): the first executable regular file wins wherever it sits on PATH;
// failing that, any entry of that name seen — a non-executable file, a
// directory — is EACCES; nothing at all is ENOENT.
const ARGV_SCRIPT = [
  'n=$1; f=$2; shift 2',
  'if [ -n "$f" ]; then',
  `  if [ -r "$f" ] && exec <"$f"; then rm -f -- "$f"; else printf '%s ESTDIN\\n' "$n" >&2; exit ${EXIT_NO_STDIN}; fi`,
  'fi',
  'c=$1; e=',
  'case $c in',
  '  */*)',
  '    if [ ! -e "$c" ]; then e=ENOENT',
  '    elif [ -d "$c" ] || [ ! -x "$c" ]; then e=EACCES',
  '    fi ;;',
  '  *)',
  '    e=ENOENT; set -f; o=$IFS; IFS=:',
  '    for d in $PATH; do',
  '      [ -n "$d" ] || d=.',
  '      if [ -f "$d/$c" ] && [ -x "$d/$c" ]; then e=; break; fi',
  '      if [ -e "$d/$c" ]; then e=EACCES; fi',
  '    done',
  '    IFS=$o; set +f ;;',
  'esac',
  `if [ -n "$e" ]; then printf '%s %s\\n' "$n" "$e" >&2; exit ${EXIT_NOT_STARTED}; fi`,
  'exec "$@"',
].join('\n');

// `/bin/sh` by path, not by name: an overlay may replace PATH, and `env(1)`
// looks its command up in the environment it has just built.
export function argvWrapper(argv: string[], { envOverlay, stdinPath, nonce }: WrapOptions): string[] {
  if (nonce === undefined) throw new Error('argvWrapper: a nonce is required');
  const assigns = Object.entries(envOverlay ?? {}).map(([k, v]) => `${k}=${v}`);
  return ['env', ...assigns, '/bin/sh', '-c', ARGV_SCRIPT, 'sh', nonce, stdinPath ?? '', ...argv];
}

// The wrapper's own failure, turned back into the never-started result spawn
// would have produced: `spawn <label> <ERRNO>` (Node's wording), code 1, empty
// streams. Only when the command exited with one of the wrapper's codes, wrote
// nothing to stdout, and stderr is EXACTLY one line carrying this call's nonce —
// everything else is the command's own result and passes through untouched.
export function unwrapResult(r: ExecResult, nonce: string, label: string): ExecResult {
  if (r.spawnError !== null || r.timedOut || r.outputOverflowed) return r;
  if (r.code !== EXIT_NOT_STARTED && r.code !== EXIT_NO_STDIN) return r;
  const stdoutEmpty = r.stdoutBytes ? r.stdoutBytes.length === 0 : r.stdout === '';
  if (!stdoutEmpty) return r;
  const err = r.stderrBytes ? r.stderrBytes.toString('utf8') : r.stderr;
  const m = /^([0-9a-f]+) (E[A-Z]+)\n$/.exec(err);
  if (!m || m[1] !== nonce) return r;
  const errno = m[2];
  const msg = `spawn ${label} ${errno}`;
  return {
    ...r,
    code: 1,
    stdout: '', stderr: msg, output: msg,
    truncated: false,
    spawnError: msg,
    ...(isSystemErrorCode(errno) ? { spawnErrorCode: errno } : {}),
    ...(r.stdoutBytes ? { stdoutBytes: Buffer.alloc(0), stderrBytes: Buffer.alloc(0) } : {}),
  };
}
