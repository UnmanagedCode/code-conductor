// What the registry's process-wide `local` handle actually IS, printed as JSON.
//
// For tests/systems-local.test.mjs, which has to vary CC_LOCAL_SYSTEM_PROVIDER
// and CC_LOCAL_SYSTEM_REMOTE_ID: the handle is a module-level singleton built at
// IMPORT time (registry.ts), so one process can only ever answer for one
// environment. Nothing here connects — ProviderSystem's constructor does not
// launch its provider — so this is a sub-second import with no child process.

import { localSystem } from '../../src/systems/registry.ts';

const sys = localSystem();
process.stdout.write(JSON.stringify({ ctor: sys.constructor.name, remoteId: sys.remoteId ?? null }) + '\n');
