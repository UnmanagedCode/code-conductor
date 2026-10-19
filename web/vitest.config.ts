// Test config lives apart from vite.config.ts: production installs omit
// devDependencies (Docker runs `npm install --omit=dev`), and the server's
// boot-time build loads vite.config.ts, so it must not import vitest.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: [path.join(here, 'src/test/setup.ts')],
    // One box-wide test slot per run (tests/testSlot.mjs), taken before any worker.
    globalSetup: [path.join(here, '../tests/vitestSlotSetup.mjs')],
    // The slot bound still lets two suites share the box; a test near the 5s
    // default when alone (web/src/parity/ledger.test.ts) cannot absorb that.
    // A real hang still fails, at this deadline.
    testTimeout: 15_000,
  },
}));
