import { test } from './harness/fixtures.ts';
import { overageDraftFlow } from './settings-overage.shared.ts';

// Its own cc: the flow commits overage prefs.
test.use({ ccOptions: { server: 'settings-overage' } });

test('a staged overage edit survives a section switch, Apply commits it and keeps its status, and reopening Settings discards an unapplied edit', overageDraftFlow);
