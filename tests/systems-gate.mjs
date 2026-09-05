// THE ACCEPTANCE GATE for the provider protocol.
//
//   npm run gate:systems
//
// Runs the ENTIRE test suite once per row with the in-process `local` system
// replaced by a ProviderSystem speaking the wire protocol to the reference
// provider.
//
// One gate, two claims:
//   * SUFFICIENCY — every project-scoped operation in the app really can be
//     expressed as the three primitives plus the derivations. Nothing in the
//     suite knows it is talking to a provider, so nothing is testing a
//     convenient subset.
//   * THE FALLBACK RUNS — a capability whose absent-behaviour has never
//     executed is a flag, not a fallback.
//
// WHICH OF THE THREE OPTIONAL CAPABILITIES (Capabilities, src/systems/protocol.ts)
// THE MATRIX MOVES. It TOGGLES one — `processGroupSignal`, one row with the
// fallback on. It carries `remotes` ON IN ROW 1 — folded into an existing pass
// rather than given its own, and cleared on row 2 — and it does not exercise
// `remoteDescriptors` at all.
//
//   * `remotes` is folded because a separate pass costs a WHOLE SUITE and buys the
//     same field on the same frames. Measured across the two rows: byte-for-byte
//     identical request-frame counts — ~13,191 per row (9,890 `exec`, 2,314
//     `writeFile`, 987 `readFile`), down to all 14 `signal` frames — differing only
//     in +237KB of `remoteId` payload on 14.96MB, i.e. +1.6%. So an unfolded
//     `remotes` row would re-send exactly those frames unnamed, which is what row 2
//     already does.
//     RE-MEASURING THAT COUNT IS WHERE IT GOES WRONG: a naive tally at
//     ProviderConnection.send() reads ~23,529, because the suite's OWN `systems-*`
//     tests spawn providers of their own — 40 such processes, ~10,338 frames. The
//     seam figure is the difference.
//   * `remoteDescriptors` is absent because a `--mirror` row is provably a
//     no-op: `mirror()` is unreachable for the system id `local` whatever class
//     backs it, since its only consumer is composeSessionRoot and both call
//     sites sit behind a redirect placement gated on `id !== LOCAL_SYSTEM_ID`.
//     Measured: a `--mirror /` row receives ZERO `describeRemote` frames across
//     the whole suite. Its fallback is proved by tests/systems-mirror-fallback.test.mjs
//     and by the `remoteDescriptors:false` row of the conformance suite.
//
// WHAT THE FOLD COSTS, so it is not discovered by surprise: no configuration
// here now runs `processGroupSignal:true` + `remotes:false` together. That cell
// is covered at UNIT level by CAPABILITY_CONFIGS[0] in
// tests/systems-protocol-conformance.test.mjs and
// tests/systems-provider-parity.test.mjs, which run inside `npm test` and
// therefore inside every row here. **If that row is ever removed from those
// suites, this fold becomes a real hole.** The remotes-OFF whole-suite path
// itself is still proved by row 2.
//
// The fold is self-proving, which is why no test asserts the negotiation:
// row 1's provider argv and its LOCAL_REMOTE_ENV binding cannot silently drift
// apart in either direction, and both directions were measured LOUD with the
// same signature — 1,286 failures against a green 4,062, at ~4x the row's wall.
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
// `RUN_CLI_CONTRACT` IS DELIBERATELY LEFT UNSET HERE. `run()` below spreads
// `...process.env`, so an exported `RUN_CLI_CONTRACT=1` enables the gated
// real-CLI family (tests/systems-cli-*.real.test.mjs) in BOTH rows with no code
// change here — measured green, both rows. Leaving it unset is a decision, not
// an oversight: the second row was measured buying no signal for its real-token
// spend, and two of that family's cases turn on the model electing to act with
// neither rate bounded. The pricing and the condition that would reopen it are
// in docs/architecture.md -> the gated real-dependency suites (card 2026-0322
// §2). This decides `RUN_CLI_CONTRACT` and nothing else: other gated families
// such as `RUN_REAL_CLAUDE` and `RUN_DOCKER_SYSTEM` reach the same one-variable
// lever and were not priced.
//
// THE TWO ROWS RUN CONCURRENTLY, and their live output interleaves. Each row's
// lines are tagged `[1] `/`[2] ` (tests/rowPrefix.mjs), mapped to names by the
// banners printed before either row starts; the closing block is printed by this
// process after both rows resolve, so it is still last and still untagged, and a
// `tail` reader still gets it whole. The tag is presentation ONLY — the scanner is
// fed the raw chunk. `TEST_CONCURRENCY` is inherited by both rows and is the lever
// on a constrained box; there is no knob of this file's own. The fake-claude
// guardrail is scoped to each run's own descendants (card 2026-0344), which is
// what makes two rows on one box possible at all.
//
// It is a separate command rather than part of `npm test` because it IS
// `npm test`, once per row. The per-configuration protocol suites
// (tests/systems-*.test.mjs) run inside the ordinary suite and cover the same
// capability matrix at the unit level, so a plain `npm test` still exercises the
// fallback; this proves the whole application over it.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_PROVIDER_ENV, LOCAL_REMOTE_ENV } from '../src/systems/registry.ts';
import { createRowScanner, renderGateSummary } from './gateSummary.mjs';
import { createRowPrefix } from './rowPrefix.mjs';

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
    name: 'processGroupSignal+remotes',
    flags: ['--remote', `${GATE_REMOTE}=/`],
    remoteId: GATE_REMOTE,
  },
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
// The row tag is a Transform IN that same chain (tests/rowPrefix.mjs), never a
// write() loop, so a false write still pauses the child's stdout exactly as the
// direct pipe did.
//
// Completeness is waited for explicitly: exit alone does not mean the pipes have
// been drained, so this resolves only once BOTH streams have ended AND the child
// has exited. `process.exit()` is not used anywhere below for the same reason —
// it would discard whatever is still buffered in our own stdout, summary included.
function run(argv, env, tag = null) {
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
    // THE SCANNER IS FED THE RAW CHUNK, before any tagging: the tag is
    // presentation, and every pattern in tests/gateSummary.mjs anchors at the start
    // of a line, so a scanner fed the tagged stream would find no failing test and
    // no verdict while the row still reported its exit code. Pinned in
    // tests/gate-row-tee.test.mjs.
    child.stdout.on('data', (chunk) => scanner.push(chunk));
    const out = tag === null ? child.stdout : child.stdout.pipe(createRowPrefix(tag));
    const err = tag === null ? child.stderr : child.stderr.pipe(createRowPrefix(tag));
    out.pipe(process.stdout, { end: false });
    err.pipe(process.stderr, { end: false });
    let code = null;
    let open = 2;
    const settle = () => {
      if (open === 0 && code !== null) resolve({ code, ...scanner.result() });
    };
    // END is observed on the LAST stream in each chain, not on the child's own:
    // with a prefixer in the path the flush of a trailing fragment happens after
    // the child's stream has ended, and the closing block must still come after it.
    out.on('end', () => { open--; settle(); });
    err.on('end', () => { open--; settle(); });
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
  // THE ROWS RUN CONCURRENTLY (card 2026-0344). Measured 107.6s against 145.4s
  // sequential, both green, and no gate claim moves — both rows still run the whole
  // suite. Isolation is STRUCTURAL and needed no work: each row's tests/run.mjs
  // mkdtemps its own safe root, mints its own CC_TEST_RUN_ID, binds ephemeral ports
  // and pins its own git config, and its orphan sweep, residual check and (since
  // card 2026-0344) fake-claude guardrail are all marker-scoped, so neither row can
  // signal or mis-count the other's processes. The BOX is the shared resource:
  // TEST_CONCURRENCY is inherited by both rows, so an operator on a constrained
  // machine lowers it there rather than through a knob of this file's own.
  //
  // Promise.all preserves array order, so renderGateSummary still renders the rows
  // in matrix order however they finish. Both rows always run to completion and
  // both diagnoses are shown — a failing row never suppressed the other and must
  // not start now.
  const argvs = CONFIGS.map(config => JSON.stringify(['node', provider, ...config.flags]));
  // Both banners BEFORE either row starts: once the rows interleave there is no
  // moment that belongs to one of them, and `[1] `/`[2] ` is what maps a live line
  // back to the name printed here.
  for (const [i, config] of CONFIGS.entries()) {
    console.log(`\n=== [${i + 1}] suite over the reference provider: ${config.name} ===`);
    console.log(`    ${LOCAL_PROVIDER_ENV}=${argvs[i]}`);
    if (config.remoteId) console.log(`    ${LOCAL_REMOTE_ENV}=${config.remoteId}`);
  }
  const rows = await Promise.all(CONFIGS.map((config, i) => run(['node', 'tests/run.mjs'], {
    [LOCAL_PROVIDER_ENV]: argvs[i],
    [LOCAL_REMOTE_ENV]: config.remoteId ?? undefined,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=512`.trim(),
  }, `[${i + 1}] `)));
  const results = CONFIGS.map((config, i) => ({ ...config, ...rows[i] }));

  console.log(`\n${renderGateSummary(results).join('\n')}`);
  const failed = results.filter(r => r.code !== 0);
  if (failed.length > 0) {
    console.error(`\ngate:systems FAILED in ${failed.length} of ${results.length} configuration(s)`);
    process.exitCode = 1;
  } else {
    console.log(`\ngate:systems PASSED in all ${results.length} configurations`);
  }
}
