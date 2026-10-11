import path from 'node:path';
import { test } from './harness/fixtures.ts';
import { FIXTURES } from './harness/boot.ts';
import { replayedReadingFlow, runEndersFlow, statisticsFlow, toolCardsFlow } from './conversation-machinery.shared.ts';

// Its own cc on the machinery scenario: a held run released by a permission-mode change, per-call usage, an Agent with totals, a system_bash call.
test.use({ ccOptions: { server: 'conversation-machinery', scenario: path.join(FIXTURES, 'scenario-conversation-machinery.json') } });

test("a run held open: clicks inside it never pin it open, its end folds it and the sub-agent's run, and opened Arguments stay open", runEndersFlow);
test('tool cards: a system_bash call shows its description and command, and an Agent card shows its subagent total on every viewport, through re-renders', toolCardsFlow);
test('the Statistics box shows the per-call lines per session, through a respawn, whatever debug capture does; the turn footer and the Agent total always show', statisticsFlow);
test("a rewind's re-sent context reading moves the header and adds nothing to the transcript", replayedReadingFlow);
