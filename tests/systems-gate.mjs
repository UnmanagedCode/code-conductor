// THE ACCEPTANCE GATE for the provider protocol.
//
//   npm run gate:systems
//
// Runs the ENTIRE test suite three times with the in-process `local` system
// replaced by a ProviderSystem speaking the wire protocol to the reference
// provider.
//
// One gate, two claims:
//   * SUFFICIENCY — every project-scoped operation in the app really can be
//     expressed as the three primitives plus the derivations. Nothing in the
//     suite knows it is talking to a provider, so nothing is testing a
//     convenient subset.
//   * BOTH FALLBACKS RUN — a capability whose absent-behaviour has never
//     executed is a flag, not a fallback.
//
// WHICH OF THE FOUR OPTIONAL CAPABILITIES (Capabilities, src/systems/protocol.ts)
// THE MATRIX MOVES. It TOGGLES two — `persistentShell` and `processGroupSignal`,
// one row each with the fallback on. It carries `remotes` ON IN ROW 1 — folded
// into an existing pass rather than given a fourth, and cleared on rows 2 and 3
// — and it does not exercise `remoteDescriptors` at all.
//
//   * `remotes` is folded because a fourth pass costs a whole suite and buys the
//     SAME field on the SAME frames. Measured: row 1 with `--remote` sends the
//     identical 14,052 request frames it sends without it — 10,223 `exec`, 2,212
//     `writeFile`, 1,617 `readFile` — differing only in carrying
//     `remoteId: "gate"` instead of nothing. The fold costs ~0.4s of the ~73s
//     pass; a fourth pass would cost ~73s to re-run those frames unnamed, which
//     rows 2 and 3 already do.
//   * `remoteDescriptors` is absent because a `--mirror` row is provably a
//     no-op: `mirror()` is unreachable for the system id `local` whatever class
//     backs it, since its only consumer is composeSessionRoot and both call
//     sites sit behind a redirect placement gated on `id !== LOCAL_SYSTEM_ID`.
//     Measured: a `--mirror /` row receives ZERO `describeRemote` frames across
//     the whole suite. Its fallback is proved by tests/systems-mirror-fallback.test.mjs
//     and by the `remoteDescriptors:false` row of the conformance suite.
//
// WHAT THE FOLD COSTS, so it is not discovered by surprise: no configuration
// here now runs `persistentShell:true` + `processGroupSignal:true` +
// `remotes:false` together. That cell is covered at UNIT level by
// CAPABILITY_CONFIGS[0] in tests/systems-protocol-conformance.test.mjs and
// tests/systems-provider-parity.test.mjs, which run inside `npm test` and
// therefore inside every row here. **If that row is ever removed from those
// suites, this fold becomes a real hole.** The remotes-OFF whole-suite path
// itself is still proved twice over, by rows 2 and 3.
//
// The fold is self-proving, which is why no test asserts the negotiation:
// row 1's provider argv and its LOCAL_REMOTE_ENV binding cannot silently drift
// apart in either direction, and both directions were measured LOUD with the
// same signature — 1,286 failures against a green 4,062, and ~302s against ~73s.
// Argv without binding: every unnamed REQUEST frame is refused ENOREMOTE by the
// provider's routing gate (which is on the requests only — a follow-on frame is
// addressed by an id already bound to a target). Binding without argv: ProviderSystem's wire-level
// backstop refuses EUNSUPPORTED before a frame goes out.
//
// The `/` root is a VACUOUS scope on purpose — the gate must not depend on where
// the host puts scratch trees. The root fence is proved by
// tests/systems-remote-id.test.mjs, not here.
//
// WHEN A ROW REDS, THE CLOSING BLOCK CARRIES THE DIAGNOSIS — the failing test
// names and the hang-guard verdict, not just PASS/FAIL. This gate is normally
// read through a `tail` of a captured log, and the first red it ever produced
// lost its failing test name to exactly that (card 2026-0290 §5c). The block is
// rendered by tests/gateSummary.mjs and tested by tests/systems-gate-summary.test.mjs.
//
// It is a separate command rather than part of `npm test` because it IS
// `npm test`, three times over. The per-configuration protocol suites
// (tests/systems-*.test.mjs) run inside the ordinary suite and cover the same
// capability matrix at the unit level, so a plain `npm test` still exercises
// both fallbacks; this proves the whole application over them.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_PROVIDER_ENV, LOCAL_REMOTE_ENV } from '../src/systems/registry.ts';
import { createRowScanner, renderGateSummary } from './gateSummary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const provider = path.join(repoRoot, 'src', 'systems', 'referenceProvider.ts');

// The target row 1 binds to. `/` is the fence, deliberately vacuous — see the
// header.
const GATE_REMOTE = 'gate';

// `remoteId` is set only on the row that carries `--remote`, and is CLEARED on
// the rows that do not — including out of an ambient value, which is why the key
// is always written rather than conditionally spread (spawn drops an `undefined`
// value, verified). A row whose provider advertises `remotes:false` reached by a
// bound handle is refused EUNSUPPORTED on every operation.
const CONFIGS = [
  {
    name: 'persistentShell+processGroupSignal+remotes',
    flags: ['--remote', `${GATE_REMOTE}=/`],
    remoteId: GATE_REMOTE,
  },
  { name: 'persistentShell:false', flags: ['--no-persistent-shell'] },
  { name: 'processGroupSignal:false', flags: ['--no-process-group-signal'] },
];

// A row's output is TEED, not swallowed: every chunk goes straight to this
// process's own stdout/stderr, and the same chunk is scanned for the two things
// the closing block needs (tests/gateSummary.mjs).
//
// BACKPRESSURE IS THE WHOLE RISK HERE — card 2026-0290 §5c. `inherit` handed the
// child our fd and the kernel did the rest; a pipe puts this process in the path,
// and `process.stdout.write` is ASYNCHRONOUS (and returns false when the buffer
// fills) whenever stdout is a pipe. A fire-and-forget `write()` per chunk would
// drop output under load — reintroducing "the diagnosis was lost", which is the
// failure this file exists to end. So the tee is `.pipe()`, which pauses the
// source on a false write and resumes on `drain`; there is no bare write() here.
//
// `setEncoding('utf8')` for the same reason in miniature: `✖` is three bytes, and
// a chunk boundary through the middle of it would corrupt both the tee and the
// scan. The decoder holds the partial sequence back instead.
//
// Completeness is waited for explicitly: exit alone does not mean the pipes have
// been drained, so this resolves only once BOTH streams have ended AND the child
// has exited. `process.exit()` is not used anywhere below for the same reason —
// it would discard whatever is still buffered in our own stdout, summary included.
function run(argv, env) {
  const scanner = createRowScanner();
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: repoRoot,
      env: {
        ...process.env,
        // Restore what the pipe takes away: the child's stdout is no longer this
        // process's terminal, so the reporter would drop colour on an interactive
        // run. Only set when we ARE a terminal, so a redirected gate stays plain.
        ...(process.stdout.isTTY ? { FORCE_COLOR: '1' } : {}),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdout.on('data', (chunk) => scanner.push(chunk));
    let code = null;
    let open = 2;
    const settle = () => {
      if (open === 0 && code !== null) resolve({ code, ...scanner.result() });
    };
    child.stdout.on('end', () => { open--; settle(); });
    child.stderr.on('end', () => { open--; settle(); });
    child.on('exit', (c, signal) => { code = signal ? 1 : c ?? 1; settle(); });
  });
}

// The gated typecheck `npm test` runs via `pretest`, done once rather than per
// configuration: it does not depend on which provider the suite talks to.
console.log('\n=== typecheck ===');
const typecheck = await run(['npm', 'run', 'typecheck'], {});
if (typecheck.code !== 0) {
  console.error('\ngate:systems FAILED — typecheck');
  process.exitCode = 1;
} else {
  const results = [];
  for (const config of CONFIGS) {
    const argv = JSON.stringify(['node', provider, ...config.flags]);
    console.log(`\n=== suite over the reference provider: ${config.name} ===`);
    console.log(`    ${LOCAL_PROVIDER_ENV}=${argv}`);
    if (config.remoteId) console.log(`    ${LOCAL_REMOTE_ENV}=${config.remoteId}`);
    const row = await run(['node', 'tests/run.mjs'], {
      [LOCAL_PROVIDER_ENV]: argv,
      [LOCAL_REMOTE_ENV]: config.remoteId ?? undefined,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=512`.trim(),
    });
    results.push({ ...config, ...row });
  }

  console.log(`\n${renderGateSummary(results).join('\n')}`);
  const failed = results.filter(r => r.code !== 0);
  if (failed.length > 0) {
    console.error(`\ngate:systems FAILED in ${failed.length} of ${results.length} configuration(s)`);
    process.exitCode = 1;
  } else {
    console.log(`\ngate:systems PASSED in all ${results.length} configurations`);
  }
}
