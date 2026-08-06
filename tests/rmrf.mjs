import { promises as fs } from 'node:fs';

export async function rmrf(p) {
  // The orchestrator does best-effort async writes into <root>/.code-conductor
  // (session titles, projects cache, …). Under concurrent test load one can land
  // between fs.rm's readdir and rmdir, throwing ENOTEMPTY (force swallows ENOENT,
  // not ENOTEMPTY). maxRetries retries exactly that class with linear backoff —
  // a deterministic wait for the late writer to finish, not a fixed sleep.
  await fs.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
