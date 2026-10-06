// Remote enumeration: which remoteIds a registered System's provider says it is
// configured to route to (docs/systems-protocol.md §2.2). The one caller behind
// both front-ends — `GET /api/systems/:id/remotes` (src/routes.ts) and the MCP
// tool `enumerate_remotes` (src/mcp/handlers.ts).
//
// THREE STATES, NEVER COLLAPSED. `listed` carries the ids, possibly none.
// `not-enumerable` and `failed` carry a reason and NEVER a list: a System that
// was never asked, or whose answer cc could not get or would not believe, read
// as `[]` would tell the user its provider is configured for nothing.
//
// NEVER REJECTS. Every per-System problem — no registry row, no provider
// command, an unreachable provider, an `error` answer, the backstop, a list
// `readRemoteList` refuses — is that System's `failed` entry, which is what
// lets `enumerateAllRemotes` report every System even when one is broken.
//
// NO CACHE, here or below: each call asks the provider afresh. The capability
// gate lives in `ProviderSystem.listRemotes`, the only sender.
//
// `local` IS DECIDED BY ID, before any handle is touched. cc's own machine is
// one machine with no named remotes (`placementOf` forces `remoteId: null` for
// it), whatever class backs the handle — and under the systems gate the handle
// is a ProviderSystem whose provider may well advertise remoteListing.

import { getSystem, getSystems } from '../appSettings.ts';
import { LOCAL_SYSTEM_ID, systemById } from './registry.ts';
import { canListRemotes } from './providerSystem.ts';

export const LOCAL_NOT_ENUMERABLE = "cc's own machine has no named remotes";

export type RemoteEnumeration =
  | { system: string; label: string; state: 'listed'; remoteIds: string[] }
  | { system: string; label: string; state: 'not-enumerable'; reason: string }
  | { system: string; label: string; state: 'failed'; reason: string; code?: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function failed(system: string, label: string, e: unknown): RemoteEnumeration {
  const code = (e as { code?: unknown } | null)?.code;
  return { system, label, state: 'failed', reason: messageOf(e), ...(typeof code === 'string' ? { code } : {}) };
}

export async function enumerateSystemRemotes(id: string): Promise<RemoteEnumeration> {
  let label = id;
  try {
    label = getSystem(id)?.label ?? id;
    if (id === LOCAL_SYSTEM_ID) return { system: id, label, state: 'not-enumerable', reason: LOCAL_NOT_ENUMERABLE };
    let sys;
    try { sys = await systemById(id, null, `remote enumeration of system '${id}'`); }
    catch (e) { return failed(id, label, e); }
    if (!canListRemotes(sys)) {
      return { system: id, label, state: 'not-enumerable', reason: `system '${id}' is not reached through a provider` };
    }
    const remoteIds = await sys.listRemotes();
    if (remoteIds === null) {
      return {
        system: id, label, state: 'not-enumerable',
        reason: `system '${id}' does not advertise remoteListing — a remote is named by hand`,
      };
    }
    // The provider's order, unchanged: §2.2 defines none, so cc adds none.
    return { system: id, label, state: 'listed', remoteIds };
  } catch (e) {
    return failed(id, label, e);
  }
}

// Every registered System, in registry order (`local` first). Per-System
// isolation comes from `enumerateSystemRemotes` never rejecting.
export async function enumerateAllRemotes(): Promise<RemoteEnumeration[]> {
  return Promise.all(getSystems().map(s => enumerateSystemRemotes(s.id)));
}
