import { test } from './harness/fixtures.ts';
import { machineLabelFlow } from './sidebar-machine-label.shared.ts';

// Its own cc: the flow's live hand-spawned sessions would otherwise sit in the shared cc's needs-you strip.
test.use({ ccOptions: { server: 'sidebar-machine-label' } });

test("a session whose first prompt the server wrote is labelled by name in its sidebar row and strip entry, with no raw syntax in either accessible name, and a person's first prompt shows unchanged", machineLabelFlow);
