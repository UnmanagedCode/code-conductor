// A deliberately misbehaving provider, for the supervision tests.
//
// Hand-written against docs/systems-protocol.md and importing NOTHING from
// `src/` — which is also a small proof that the wire contract is writable from
// the document alone.
//
//   node tests/fake-provider.mjs --mode <mode> [--count-file <p>] [--code <CODE>]
//
// Modes:
//   ok            behaves (used as the "restarted successfully" half)
//   boom          exits 3 before saying hello
//   silent        never answers the handshake
//   bad-version   answers with a protocol version cc does not speak
//   garbage       says hello, then emits a line that is not JSON
//   conn-error    says hello, then emits an id-less error frame
//   crash-once    says hello; exits on the FIRST launch's first request, behaves on later ones
//   wedge         says hello, accepts every request, answers nothing
//   double-exit   says hello, answers an exec with TWO exit frames

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const mode = opt('--mode', 'ok');
const countFile = opt('--count-file', null);
const code = opt('--code', 'EPROTO');

// Launch counter: how a test proves cc did (or did not) attempt a restart.
let launch = 1;
if (countFile) {
  let prev = 0;
  try { prev = Number(readFileSync(countFile, 'utf8').trim()) || 0; } catch { prev = 0; }
  launch = prev + 1;
  writeFileSync(countFile, String(launch));
}

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
process.stdout.on('error', () => process.exit(0));

if (mode === 'boom') process.exit(3);

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(f) {
  if (f.type === 'hello') {
    if (mode === 'silent') return;
    send({
      type: 'hello',
      protocol: mode === 'bad-version' ? 99 : 1,
      provider: `fake-${mode}/0.1.0`,
      capabilities: { persistentShell: true, processGroupSignal: true },
      system: { os: 'linux', pathSep: '/', shell: '/bin/bash', home: '/root' },
    });
    if (mode === 'garbage') setTimeout(() => process.stdout.write('this is not a frame\n'), 30);
    if (mode === 'conn-error') setTimeout(() => send({ type: 'error', code, message: 'the fake reports a channel fault' }), 30);
    return;
  }
  // wedge / garbage / conn-error answer NOTHING, so an operation is still open
  // when the misbehaviour below lands on it.
  if (mode === 'wedge' || mode === 'garbage' || mode === 'conn-error') return;
  if (mode === 'crash-once' && launch === 1) { process.exit(4); }
  // The behaving path: enough of the protocol for a restart to be observable.
  if (f.type === 'exec') {
    send({ type: 'stdout', id: f.id, seq: 0, dataB64: Buffer.from(`fake launch ${launch}\n`).toString('base64') });
    send({ type: 'exit', id: f.id, code: 0, signal: null, timedOut: false });
    if (mode === 'double-exit') send({ type: 'exit', id: f.id, code: 77, signal: null, timedOut: false });
    return;
  }
  if (f.type === 'readFile') {
    const data = Buffer.from(`fake launch ${launch}`);
    send({ type: 'readFileResult', id: f.id, size: data.length, mode: 0o100644, isBinary: false });
    send({ type: 'data', id: f.id, seq: 0, dataB64: data.toString('base64') });
    send({ type: 'end', id: f.id });
    return;
  }
  if (countFile && f.type === 'end') appendFileSync(countFile, '');
}
