// Once per run: sweep the scratch roots a SIGKILLed run left, then build
// web/dist with the server's own hash-gated build. A failed build THROWS: the
// previous dist would keep serving, and a spec — or a mutant scored by one —
// would be judged against a stale bundle.

import { ensureWebBuild } from '../../../src/webBuild.ts';
import { sweepStaleRoots } from './scratch.ts';

export default async function globalSetup(): Promise<void> {
  sweepStaleRoots();
  const state = await ensureWebBuild();
  if (state.phase !== 'ready') throw new Error(`web build failed: ${state.error}`);
}
