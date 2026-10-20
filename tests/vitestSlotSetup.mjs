// Vitest globalSetup (web/vitest.config.ts): one box-wide test slot for the run.
// Vitest awaits globalSetup before any worker starts, so the lease gates every
// worker. The held marker goes into this process's env, which the workers and
// whatever a test spawns inherit, so a nested leased runner takes no slot of its
// own. A watch session takes none, so it never pins a slot. Slot rules:
// tests/testSlot.mjs.
import { acquireTestSlot } from './testSlot.mjs';

export default async function setup(project) {
  if (project.config.watch) return undefined;
  const lease = await acquireTestSlot({ label: 'vitest' });
  Object.assign(process.env, lease.env);
  return () => lease.release();
}
