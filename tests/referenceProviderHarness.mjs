// Shared fixture for the protocol suites: a ProviderSystem wired to the
// reference provider, in each capability configuration.
//
// EVERY protocol suite runs its battery across all configurations, not just
// whichever one the ambient CC_LOCAL_SYSTEM_PROVIDER happens to select. That is
// what makes `npm test` alone prove the fallback; the whole-suite gate
// (`npm run gate:systems`) then proves that the protocol is SUFFICIENT for the
// rest of the app in each of them.
//
// THIS MATRIX AND THE GATE'S ARE TWO MATRICES, NOT ONE, and deliberately differ.
// This is a UNIT matrix over the TOGGLED capability, so its first entry stays
// `remotes:false` and the remotes tests launch their own providers. The gate's
// first row additionally carries `--remote` (card 2026-0266); do not unify the
// two lists to make them agree. They shrank from three entries to two on card
// 2026-0312 for their OWN reasons, at the same time — a coincidence, not a
// coupling.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { parseProviderLaunch } from '../src/systems/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REFERENCE_PROVIDER = path.join(__dirname, '..', 'src', 'systems', 'referenceProvider.ts');

// THE PROVIDER UNDER TEST. Defaults to cc's reference provider; set
// `CC_CONFORMANCE_PROVIDER` to a JSON argv array to run the same battery
// against your own:
//
//   CC_CONFORMANCE_PROVIDER='["python3","my_provider.py"]' \
//     node tests/run.mjs tests/systems-protocol-conformance.test.mjs
//
// WHAT THE SUITE APPENDS to that argv: each entry of `CAPABILITY_CONFIGS`
// below contributes its `flags` to the core battery, and the `remotes` /
// `remoteDescriptors` fixtures launch their own providers with `--remote`,
// `--mirror` and `--exclude` on top. A provider being verified has to accept
// (or map) those flags to be exercised in every configuration.
//
// The suite is NOT shape-neutral, and `docs/systems-protocol.md` §10 says so:
// the core fixtures build an UNBOUND handle, so a provider that serves only
// named targets must answer every core frame `ENOREMOTE` (§8) and loses most of
// the battery. `CC_CONFORMANCE_REMOTE_ID` below is that provider's way in.
export const PROVIDER_ARGV_ENV = 'CC_CONFORMANCE_PROVIDER';

// WHICH TARGET the fixture handles are bound to, for a provider that serves
// named ones. Unset — the default, and every in-repo importer — leaves them
// unbound, exactly as before. This is to the conformance suite what
// `CC_LOCAL_SYSTEM_REMOTE_ID` is to `npm test` (docs/systems-protocol.md §10):
//
//   CC_CONFORMANCE_PROVIDER='["node","my_provider.js","--remote","t=/"]' \
//     CC_CONFORMANCE_REMOTE_ID=t \
//     node tests/run.mjs tests/systems-protocol-conformance.test.mjs
//
// A fixture that is ABOUT the unbound case passes `{ remoteId: null }`
// explicitly, which wins over this.
export const REMOTE_ID_ENV = 'CC_CONFORMANCE_REMOTE_ID';

// Same parser the registry uses for CC_LOCAL_SYSTEM_PROVIDER — one spelling of
// "a provider launch command", so the gate and the conformance suite cannot
// disagree about what a valid value looks like.
function baseArgv() {
  const spec = process.env[PROVIDER_ARGV_ENV]?.trim();
  return spec ? parseProviderLaunch(spec, PROVIDER_ARGV_ENV) : ['node', REFERENCE_PROVIDER];
}

export function providerArgv(flags = []) {
  return [...baseArgv(), ...flags];
}

// True when the suite is running against cc's own reference provider, so the
// handful of assertions that name it can stay exact for the default run and
// relax for a third-party one.
export const IS_REFERENCE_PROVIDER = !process.env[PROVIDER_ARGV_ENV]?.trim();

// NOTE for a third-party provider: the suite builds its fixtures with node's
// own `fs` and then asks the provider about them, so it verifies a provider
// that reaches THE SAME FILESYSTEM as the test process. Verifying a provider on
// another machine needs the fixtures built over the protocol too — a bigger
// change than this harness, and out of scope until a transport exists.
//
// The UNIT configurations. `caps` is what the handshake must report, so a test
// can assert the negotiation rather than trust the flag —
// `assertNegotiatedCapabilities` below is the one reader, and the one place the
// third-party relaxation lives.
//
// Neither passes `--remote` or `--mirror`, so both report
// `remotes:false` and `remoteDescriptors:false`. That is a property of THIS
// matrix, not of the gate's — see the divergence note at the top of the file.
// `remotes` and `remoteDescriptors` have their own multi-target/mirror fixtures,
// which register their own systems and work under every configuration here:
// tests/systems-remote-id.test.mjs and
// tests/systems-mirror-advertisement.test.mjs. For `remoteDescriptors` the
// present-behaviour is unreachable through the LOCAL system whatever backs it —
// mirror()'s only consumer is composeSessionRoot, and both its call sites sit
// behind a redirect placement gated on `id !== LOCAL_SYSTEM_ID`.
export const CAPABILITY_CONFIGS = [
  {
    name: 'all capabilities',
    flags: [],
    caps: { processGroupSignal: true, remotes: false, remoteDescriptors: false },
  },
  {
    name: 'processGroupSignal:false',
    flags: ['--no-process-group-signal'],
    caps: { processGroupSignal: false, remotes: false, remoteDescriptors: false },
  },
];

// A ProviderSystem over a freshly launched reference provider. The caller
// disposes it; nothing here is shared between tests.
export function makeProviderSystem(flags = [], opts = {}) {
  return new ProviderSystem({
    id: 'ref', launch: { argv: providerArgv(flags) }, remoteId: conformanceRemoteId(), ...opts,
  });
}

// The ONE read of REMOTE_ID_ENV, so a fixture that hand-builds a frame or a
// provider flag binds it the same way `makeProviderSystem` does.
export function conformanceRemoteId() {
  return process.env[REMOTE_ID_ENV]?.trim() || null;
}

// The capabilities THIS matrix toggles, derived from the matrix rather than
// named here so a flag added to `CAPABILITY_CONFIGS` extends the assertion too.
export const TOGGLED_CAPABILITIES = Object.keys(CAPABILITY_CONFIGS[0].caps)
  .filter(k => CAPABILITY_CONFIGS.some(c => c.caps[k] !== CAPABILITY_CONFIGS[0].caps[k]));

// The handshake's capability assertion. EXACT for the reference provider: the
// flags it was launched with are the whole of what it advertises.
//
// RELAXED for a third-party provider, on ONE axis only — the toggled
// capabilities must still match, and `remotes`/`remoteDescriptors` may be a
// SUPERSET. A provider kind that serves many targets (a container id per
// target) advertises `remotes:true` always; making it lie to get through the
// suite would be a test-only divergence in the one field cc negotiates on.
//
// Split out of the suite so both halves are drivable without launching a
// provider (tests/systems-protocol-conformance.test.mjs → T2).
export function assertNegotiatedCapabilities(caps, config, isReference = IS_REFERENCE_PROVIDER) {
  if (isReference) {
    assert.deepEqual(caps, config.caps, 'the flags the provider was launched with are what it advertises');
    return;
  }
  assert.ok(TOGGLED_CAPABILITIES.length > 0, 'a matrix that toggles nothing pins nothing');
  for (const cap of TOGGLED_CAPABILITIES) {
    assert.equal(caps[cap], config.caps[cap],
      `${cap}: the flag the provider was launched with is what it advertises`);
  }
}
