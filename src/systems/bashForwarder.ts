// The local stand-in for a redirected `Bash`.
//
// `PreToolUse` rewrites the worker's command into an invocation of THIS script
// (src/systems/toolRedirect.ts). The CLI runs it on cc's machine, as it runs
// every Bash command; the script hands the original command to cc over
// loopback, cc runs it in its own shell on the system and STREAMS the output
// back, and the script replays it as its own — stdout on stdout, stderr on
// stderr, exit code as its exit code. To the CLI and to the model it is an
// ordinary Bash call whose output happens to describe the other machine.
//
// IT WRITES AS IT READS. A build or a test run has to reach the worker while it
// is still running: `run_in_background` + `BashOutput` poll this process's
// stdout, and a long foreground command should not be silent until it exits. So
// the response is NDJSON — one frame per line — parsed a line at a time and
// replayed immediately. Nothing here may accumulate the body.
//
// It is a SEPARATE PROCESS, not a shell one-liner, for two reasons: the
// original command travels as one argv element, so no quoting of it survives
// into a second shell; and the CLI's own kill of this process — on an interrupt,
// or when the worker stops a background task — closes the HTTP socket, which is
// how cc learns to kill the command on the far side.
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

// ONE FLAG AND THE COMMAND. Neither the tool's `timeout` nor the dispatching
// agent's id travels any more (card 2026-0312). The timeout's only consumer was
// a queue that no longer exists, and cc needs the number for nothing: at the
// tool timeout the CLI DETACHES this process rather than killing it, handing the
// agent a background task while the command keeps running on the system (card
// 2026-0305 §3), bounded by cc's own ceiling. A kill, when one comes, closes the
// socket — cc's cancellation channel, which carries no number either. The agent
// id's only consumer was a per-agent shell, which is gone because no command's
// state reaches any later one.
function parseArgs(argv: string[]): { url: string; command: string } {
  let url = '';
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--url') { url = argv[++i] ?? ''; continue; }
    if (argv[i] === '--') { i++; break; }
    break;
  }
  return { url, command: argv.slice(i).join(' ') };
}

const { url, command } = parseArgs(process.argv.slice(2));
if (!url || !command) fail('malformed forwarder invocation');

const body = JSON.stringify({ command });
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
    // cc's notice goes on stderr, not stdout, so it can never be mistaken for
    // the command's own output. It arrives AFTER the command has settled —
    // where the command ended cannot be known before then — and cc is what
    // orders the frames; this only preserves that order by writing each as it
    // arrives.
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
