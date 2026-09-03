// The local stand-in for a redirected `Bash`.
//
// `PreToolUse` rewrites the worker's command into an invocation of THIS script
// (src/systems/toolRedirect.ts). The CLI runs it on cc's machine, as it runs
// every Bash command; the script hands the original command to cc over
// loopback, cc runs it in that AGENT's long-lived shell on the system and
// STREAMS the output back, and the script replays it as its own — stdout on
// stdout, stderr on stderr, exit code as its exit code. To the CLI and to the
// model it is an ordinary Bash call whose output happens to describe the other
// machine.
//
// IT WRITES AS IT READS. A build or a test run has to reach the worker while it
// is still running: `run_in_background` + `BashOutput` poll this process's
// stdout, and a long foreground command should not be silent until it exits. So
// the response is NDJSON — one frame per line — parsed a line at a time and
// replayed immediately. Nothing here may accumulate the body.
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
import { StringDecoder } from 'node:string_decoder';

interface Frame { t?: string; text?: string; code?: number }

function fail(message: string): never {
  process.stderr.write(`cc: redirected Bash failed: ${message}\n`);
  process.exit(1);
}

// `--agent` names the AGENT this command belongs to — the main agent's
// invocation carries none. It is on the argv because the rewrite is the only
// place cc knows it: the hook that carried `agent_id` is long finished by the
// time the CLI spawns this process, so the id has to travel out on the command
// line and back on the request body.
//
// THE TOOL'S `timeout` DOES NOT TRAVEL. The CLI enforces it by killing this
// process, which closes the socket — that is cc's cancellation channel, and it
// needs no number (card 2026-0312 §2 D-b).
function parseArgs(argv: string[]): { url: string; agentId: string | null; command: string } {
  let url = '';
  let agentId: string | null = null;
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--url') { url = argv[++i] ?? ''; continue; }
    if (argv[i] === '--agent') { agentId = argv[++i] ?? null; continue; }
    if (argv[i] === '--') { i++; break; }
    break;
  }
  return { url, agentId, command: argv.slice(i).join(' ') };
}

const { url, agentId, command } = parseArgs(process.argv.slice(2));
if (!url || !command) fail('malformed forwarder invocation');

const body = JSON.stringify({
  command,
  ...(agentId ? { agentId } : {}),
});
const req = http.request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  // Line-buffered over a byte stream: a frame can be split across two TCP
  // reads, and half a JSON object is not a frame. The decoder keeps a
  // multi-byte character whole across the same boundary.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let exitCode: number | null = null;
  let broken: string | null = null;

  const handle = (line: string) => {
    if (line === '') return;
    let f: Frame;
    try { f = JSON.parse(line) as Frame; }
    catch { broken ??= `cc replied with a line this script could not parse: ${line.slice(0, 200)}`; return; }
    // The reset notice goes out ahead of the command's own output, on stderr: a
    // shell that lost its exports has to SAY so, or the worker reads the next
    // failure as the command's fault (R5). cc orders the frames; this only
    // preserves that order by writing each as it arrives.
    if (f.t === 'notice') process.stderr.write(`${f.text ?? ''}\n`);
    else if (f.t === 'out') process.stdout.write(f.text ?? '');
    else if (f.t === 'err') process.stderr.write(f.text ?? '');
    else if (f.t === 'exit') exitCode = typeof f.code === 'number' ? f.code : 1;
  };

  res.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let nl: number;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      handle(line);
    }
  });
  res.on('end', () => {
    handle(pending + decoder.end());
    if (broken) fail(broken);
    // No terminal frame means cc never told us how the command ended — the
    // connection was cut mid-answer. Exiting 0 would report a command nobody
    // knows the fate of as a success.
    if (exitCode === null) fail(`cc closed the connection without an exit code (HTTP ${res.statusCode})`);
    process.exit(exitCode);
  });
});
// cc is on loopback and is the process that spawned the CLI that spawned this,
// so a connection error means cc itself is gone — report it rather than hang.
req.on('error', (e: Error) => fail(`could not reach code-conductor at ${url}: ${e.message}`));
req.end(body);
