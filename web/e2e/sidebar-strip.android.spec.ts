import path from 'node:path';
import { FIXTURES } from './harness/boot.ts';
import { test } from './harness/fixtures.ts';
import { askFlow, badgeFlow, fitFlow } from './sidebar-strip.shared.ts';

test.use({ ccOptions: { server: 'sidebar-strip', scenario: path.join(FIXTURES, 'scenario-sidebar-strip.json') } });

test('real sessions land in one strip group as they run, wait on a worker and ask; a re-invoked conductor stays Waiting; opening one and replying clears its ask; a resume re-derives plan and question asks; both lenses show the same strip', askFlow);
test('every strip × is reachable by pointer, touch and keyboard, lies inside the viewport and closes its entry without opening it; the sidebar does not overflow sideways; a strip click opens the session and closes the drawer', fitFlow);
test("an armed entry's label stays readable and truncates while its auto-resume badge truncates, and its × stays inside the viewport", badgeFlow);
