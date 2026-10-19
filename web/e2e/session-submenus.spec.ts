import { test } from './harness/fixtures.ts';
import { drillThenEffortFlow, seedSession, submenusFlow } from './session-submenus.shared.ts';

test.use({ ccOptions: { server: 'session-submenus' } });
test.beforeAll(async ({ cc }) => { await seedSession(cc); });

test('Change model rows fit the viewport and their menu, are hit at their centre and show their label uncut; beside the menu on desktop, in place on a phone', submenusFlow('Change model'));
test('Change effort rows fit the viewport and their menu, are hit at their centre and show their label uncut; beside the menu on desktop, in place on a phone', submenusFlow('Change effort'));
test('on a phone, Change effort drills after Change model was drilled and left', drillThenEffortFlow);
