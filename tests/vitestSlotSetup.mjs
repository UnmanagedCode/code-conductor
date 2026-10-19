// Vitest globalSetup (web/vitest.config.ts): one box-wide test slot for the run.
// Vitest awaits globalSetup before any worker starts, so the lease gates every
// worker. A watch session takes none, so it never pins a slot. Slot rules:
// tests/testSlot.mjs.
import { acquireTestSlot } from './testSlot.mjs';

export default async function setup(project) {
  if (project.config.watch) return undefined;
  const lease = await acquireTestSlot({ label: 'vitest' });
  return () => lease.release();
}
