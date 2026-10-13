import { test } from './harness/fixtures.ts';
import { closeThenReloadFlow, overtakenListReadFlow } from './session-restore.shared.ts';

// Its own cc: the flows spawn sessions.
test.use({ ccOptions: { server: 'session-restore' } });

test('the session a URL names opens on first load while a newer instance-list read is still in flight', overtakenListReadFlow);

test('closing the open session drops its anchor without a history entry, and a reload resumes nothing', closeThenReloadFlow);
