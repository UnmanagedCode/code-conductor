// The local stand-in for a redirected `Bash`.
//
// `PreToolUse` rewrites the worker's command into an invocation of THIS script
// (src/systems/toolRedirect.ts). The CLI runs it on cc's machine, as it runs
// every Bash command; the script hands the original command to cc over
// loopback, cc runs it in the session's long-lived shell on the system, and the
// script replays the result as its own — stdout on stdout, stderr on stderr,
// exit code as its exit code. To the CLI and to the model it is an ordinary
// Bash call whose output happens to describe the other machine.
//
// It is a SEPARATE PROCESS, not a shell one-liner, for two reasons: the
// original command travels as one argv element, so no quoting of it survives
// into a second shell; and the CLI's own kill of this process — on a tool
// timeout or an interrupt — closes the HTTP socket, which is how cc learns to
// kill the command on the far side.
//
// Node builtins only. It is spawned by whatever shell the CLI uses, with
// process.execPath as argv[0], so it must not depend on cwd, PATH or the
// repo's dependencies.

import http from 'node:http';

interface Reply { stdout?: string; stderr?: string; code?: number; notice?: string }

function fail(message: string): never {
  process.stderr.write(`cc: redirected Bash failed: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): { url: string; timeoutMs: number | null; command: string } {
  let url = '';
  let timeoutMs: number | null = null;
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--url') { url = argv[++i] ?? ''; continue; }
    if (argv[i] === '--timeout') { timeoutMs = Number(argv[++i]); continue; }
    if (argv[i] === '--') { i++; break; }
    break;
  }
  return { url, timeoutMs, command: argv.slice(i).join(' ') };
}

const { url, timeoutMs, command } = parseArgs(process.argv.slice(2));
if (!url || !command) fail('malformed forwarder invocation');

const body = JSON.stringify({ command, ...(timeoutMs && Number.isFinite(timeoutMs) ? { timeoutMs } : {}) });
const req = http.request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let reply: Reply;
    try { reply = JSON.parse(text) as Reply; }
    catch { fail(`cc replied with ${res.statusCode} and a body this script could not parse: ${text.slice(0, 400)}`); }
    // The reset notice goes on stderr, ahead of the command's own output: a
    // shell that lost its exports has to SAY so, or the worker reads the next
    // failure as the command's fault (R5).
    if (reply.notice) process.stderr.write(`${reply.notice}\n`);
    if (reply.stdout) process.stdout.write(reply.stdout);
    if (reply.stderr) process.stderr.write(reply.stderr);
    process.exit(typeof reply.code === 'number' ? reply.code : 1);
  });
});
// cc is on loopback and is the process that spawned the CLI that spawned this,
// so a connection error means cc itself is gone — report it rather than hang.
req.on('error', (e: Error) => fail(`could not reach code-conductor at ${url}: ${e.message}`));
req.end(body);
