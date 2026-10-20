// A Vitest worker runs under the run's box-wide test slot: tests/vitestSlotSetup.mjs
// puts the held marker in the env the workers inherit, so a leased runner a test
// spawns takes no slot of its own. When SLOT_MARKER names a file, the test also
// records the marker there, so tests/test-slot-wiring.test.mjs can observe when a
// worker first ran.
import fs from 'node:fs';
import { expect, it } from 'vitest';

it.skipIf(process.env.VITEST_MODE === 'WATCH')('a worker inherits the held marker', () => {
  const held = process.env.CC_TEST_SLOT_HELD;
  if (process.env.SLOT_MARKER) fs.writeFileSync(process.env.SLOT_MARKER, `held=${held}`);
  expect(held).toMatch(/^\d+$/);
});
