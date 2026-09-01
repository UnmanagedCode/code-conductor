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
// It is a separate command rather than part of `npm test` because it IS
// `npm test`, three times over. The per-configuration protocol suites
// (tests/systems-*.test.mjs) run inside the ordinary suite and cover the same
// capability matrix at the unit level, so a plain `npm test` still exercises
// both fallbacks; this proves the whole application over them.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_PROVIDER_ENV, LOCAL_REMOTE_ENV } from '../src/systems/registry.ts';

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

function run(argv, env) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

// The gated typecheck `npm test` runs via `pretest`, done once rather than per
// configuration: it does not depend on which provider the suite talks to.
console.log('\n=== typecheck ===');
if (await run(['npm', 'run', 'typecheck'], {}) !== 0) {
  console.error('\ngate:systems FAILED — typecheck');
  process.exit(1);
}

const results = [];
for (const config of CONFIGS) {
  const argv = JSON.stringify(['node', provider, ...config.flags]);
  console.log(`\n=== suite over the reference provider: ${config.name} ===`);
  console.log(`    ${LOCAL_PROVIDER_ENV}=${argv}`);
  if (config.remoteId) console.log(`    ${LOCAL_REMOTE_ENV}=${config.remoteId}`);
  const code = await run(['node', 'tests/run.mjs'], {
    [LOCAL_PROVIDER_ENV]: argv,
    [LOCAL_REMOTE_ENV]: config.remoteId ?? undefined,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=512`.trim(),
  });
  results.push({ ...config, code });
}

console.log('\n=== gate:systems ===');
for (const r of results) console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}`);
const failed = results.filter(r => r.code !== 0);
if (failed.length > 0) {
  console.error(`\ngate:systems FAILED in ${failed.length} of ${results.length} configuration(s)`);
  process.exit(1);
}
console.log(`\ngate:systems PASSED in all ${results.length} configurations`);
