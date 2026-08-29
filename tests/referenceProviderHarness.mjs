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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REFERENCE_PROVIDER = path.join(__dirname, '..', 'src', 'systems', 'referenceProvider.ts');

export function providerArgv(flags = []) {
  return ['node', REFERENCE_PROVIDER, ...flags];
}

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
