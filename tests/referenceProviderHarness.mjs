// Shared fixture for the protocol suites: a ProviderSystem wired to the
// reference provider, in each capability configuration.
//
// EVERY protocol suite runs its battery across all three configurations, not
// just whichever one the ambient CC_LOCAL_SYSTEM_PROVIDER happens to select.
// That is what makes `npm test` alone prove both fallbacks; the three-way whole-
// suite gate (`npm run gate:systems`) then proves that the protocol is
// SUFFICIENT for the rest of the app in each of them.

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
// The capability flags below are APPENDED to that argv, so a provider being
// verified has to accept `--no-persistent-shell` / `--no-process-group-signal`
// (or map them) to be exercised in all three configurations. Nothing in the
// suite is otherwise specific to the reference provider — that is what makes
// "the conformance suite is the definition of a valid provider" true rather
// than aspirational.
export const PROVIDER_ARGV_ENV = 'CC_CONFORMANCE_PROVIDER';

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
// The three configurations of the acceptance gate. `caps` is what the handshake
// must report, so a test can assert the negotiation rather than trust the flag.
export const CAPABILITY_CONFIGS = [
  {
    name: 'all capabilities',
    flags: [],
    caps: { persistentShell: true, processGroupSignal: true },
  },
  {
    name: 'persistentShell:false',
    flags: ['--no-persistent-shell'],
    caps: { persistentShell: false, processGroupSignal: true },
  },
  {
    name: 'processGroupSignal:false',
    flags: ['--no-process-group-signal'],
    caps: { persistentShell: true, processGroupSignal: false },
  },
];

// A ProviderSystem over a freshly launched reference provider. The caller
// disposes it; nothing here is shared between tests.
export function makeProviderSystem(flags = [], opts = {}) {
  return new ProviderSystem({ id: 'ref', launch: { argv: providerArgv(flags) }, ...opts });
}
