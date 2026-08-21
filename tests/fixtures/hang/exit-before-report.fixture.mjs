// Exits before registering a single test, so the file produces no tests, no
// failure, and no report. This is the truncation class that made a
// --test-force-exit scan silently lose tests/mcp-conductor-view.test.mjs (38
// tests) while still printing `fail 0` and exiting 0. The completeness ledger
// must name it regardless of cause.
process.exit(0);
