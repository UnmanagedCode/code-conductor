// The sidebar's label for a session whose first prompt the server wrote — a wake-callback stub, a
// send_prompt({forward}) frame, a renew_session seed — on a real server, which stores only that prompt's head, so the
// label is derived from the cut the browser actually receives. A person's first prompt is the negative control.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Page } from '@playwright/test';
import { createProject, mcpCall, spawnSession } from './harness/api.ts';
import { expect, test, type Cc } from './harness/fixtures.ts';
import { idleInst, insts, type FleetInst } from './flows/fleet.ts';
import { next, nextSidebar } from './flows/ui.ts';
import { buildWakeStub } from '../../shared/wakeCallback.ts';
import { buildForwardFrame } from '../../shared/forwardFrame.ts';
import { buildRenewSeed } from '../../shared/renewSeed.ts';

type Ctx = { page: Page; cc: Cc };
/** An instance as `/api/instances` lists it, with the first prompt the server stored. */
type Inst = FleetInst & { firstPrompt?: string | null };
type Case = { what: string; prompt: string; stored: RegExp; label: string | RegExp; name: RegExp };

const label = (s: string) => `e2e-machine-label-${s}-${test.info().project.name}`;
/** Raw machine-prompt syntax no label may carry: the marker, the forward frame's header, the renew seed's preamble. */
const RAW = /\[\[cc:|FORWARDED WORKER OUTPUT|Your context was just renewed/;

const CASES: Case[] = [
  {
    what: 'human', prompt: 'machine-label human prompt',
    stored: /^machine-label human prompt$/, label: 'machine-label human prompt', name: /machine-label human prompt/,
  },
  {
    what: 'wake', prompt: buildWakeStub({ targetSessionId: 'labelwake', payloadText: '{"sessionId":"labelwake"}\nWAKE-LABEL prose' }),
    stored: /^\[\[cc:wake-callback\]\]Worker `labelwake`/, label: /^Wake: Worker `labelwake` finished its turn\./, name: /Wake: Worker `labelwake` finished its turn\./,
  },
  {
    what: 'forward', prompt: buildForwardFrame({ messages: ['FWD-LABEL body'], instruction: 'FWD-LABEL instruction' }),
    stored: /^--- END FORWARDED WORKER OUTPUT ---\n\nFWD-LABEL instruction$/, label: 'FWD-LABEL instruction', name: /FWD-LABEL instruction/,
  },
  {
    what: 'renew', prompt: buildRenewSeed({ summary: 'RENEW-LABEL summary' }),
    stored: /^Your context was just renewed/, label: 'Context renewed', name: /Context renewed/,
  },
];

// Invariant: a session row and a needs-you entry never show a machine-written first prompt's raw syntax, in their text or
// accessible name: a wake stub reads by its summary, a forward frame by its instruction's first line, a renew seed by name; a
// person's prompt is unchanged.
export async function machineLabelFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(cc.engine === 'live', 'the prompts are sent to fake-engine sessions');
  test.setTimeout(120_000);
  const P = label('proj');
  await createProject(cc, P);
  const sids = new Map<string, string>();
  for (const c of CASES) {
    const s = await spawnSession(cc, P);
    await idleInst(cc, (i) => i.id === s.id, `${c.what} session idle`);
    await mcpCall(cc, 'send_prompt', { sessionId: s.sessionId, text: c.prompt });
    sids.set(c.what, s.sessionId);
  }

  await test.step('the server stores each first prompt\'s head', async () => {
    for (const c of CASES) {
      const sid = sids.get(c.what)!;
      await expect.poll(async () => ((await insts(cc)) as Inst[]).find((i) => i.sessionId === sid)?.firstPrompt ?? '', { message: `${c.what} firstPrompt` })
        .toMatch(c.stored);
    }
  });

  await next.open(page);
  await next.lens(page, 'projects');
  for (const c of CASES) {
    const sid = sids.get(c.what)!;
    await test.step(`the ${c.what} session's row and strip entry`, async () => {
      const row = nextSidebar(page).locator(`[data-session-row="${sid}"] > [data-row]`);
      await expect(row.locator('span.truncate').first()).toHaveText(c.label);
      await expect(row.locator('[data-row-open]')).toHaveAccessibleName(c.name);
      await expect(row.locator('[data-row-open]')).not.toHaveAccessibleName(RAW);
      const entry = nextSidebar(page).locator(`[data-strip-entry="${sid}"] > button`);
      await expect(entry.locator('[data-strip-label]')).toHaveText(c.label);
      await expect(entry).toHaveAccessibleName(c.name);
      await expect(entry).not.toHaveAccessibleName(RAW);
    });
  }
}
