// Exits before registering a single test, so the file produces no tests, no
// failure, and no report. This is the truncation class that made a
// --test-force-exit scan silently lose tests/mcp-conductor-view.test.mjs (38
// tests) while still printing `fail 0` and exiting 0. The completeness ledger
// must name it regardless of cause.
//
// The marker is the file's only output, and the quiet reporter must print it:
// with no summary and no failure, only the end of the run releases it.
import { writeSync } from 'node:fs';

writeSync(2, 'exit-before-report: exiting before any test\n');
process.exit(0);
