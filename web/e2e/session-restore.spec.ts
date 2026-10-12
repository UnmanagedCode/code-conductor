import { test } from './harness/fixtures.ts';
import { overtakenListReadFlow } from './session-restore.shared.ts';

// Its own cc: the flow spawns a session.
test.use({ ccOptions: { server: 'session-restore' } });

test('the session a URL names opens on first load while a newer instance-list read is still in flight', overtakenListReadFlow);
