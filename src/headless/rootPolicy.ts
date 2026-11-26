// The root conductor's no-person policy: what a headless boot does where a
// person would act on the root. One copy, used by the live run
// (src/headless/runner.ts) and by a replay that resumes the root
// (src/headless/replayRoot.ts, src/headless/replay.ts).

import { buildApprovePrompt } from '../../shared/planApproval.ts';
import { HEADLESS_QUESTION_ANSWER } from './fragment.ts';
import type { InstanceLike, InstanceSummary } from '../instanceTypes.ts';
import { errMsg } from '../../shared/basics.ts';

// How long a signal waits on the root's forced interrupt before the boot ends anyway.
export const INTERRUPT_WAIT_MS = 5_000;

/** Forces the root's interrupt and resolves once it settles or `waitMs` passes, whichever is first. Never rejects. */
export async function forceInterrupt(root: InstanceLike, waitMs: number = INTERRUPT_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    root.interrupt({ force: true }).catch(() => {}),
    new Promise<void>((res) => { timer = setTimeout(res, waitMs); }),
  ]);
  clearTimeout(timer);
}

/**
 * The root's tool asks, answered once per ask with no person present: a
 * question gets HEADLESS_QUESTION_ANSWER, a plan is approved as the UI's
 * Approve does (out of plan mode first). Feed it the root's status summaries;
 * a failed send names itself through `onError`. One answerer per instance:
 * `liveAsks` counts from zero per instance.
 */
export function rootAskAnswerer(root: InstanceLike, onError: (message: string) => void): (s: InstanceSummary) => void {
  let answeredAsks = 0;
  const send = (text: string): Promise<void> => root.promptOrQueueSteer(text, [], { author: 'human' })
    .catch((e: unknown) => { onError(`answering the root conductor failed: ${errMsg(e)}`); });
  return (s) => {
    const asks = s.liveAsks ?? 0;
    if (s.awaitingUserSource !== 'tool' || asks <= answeredAsks) return;
    answeredAsks = asks;
    if (s.awaitingUser === 'question') { void send(HEADLESS_QUESTION_ANSWER); return; }
    if (s.awaitingUser !== 'plan') return;
    // The plan the auto-approve rule did not take (code mode, or out of plan
    // mode): approved as the UI's Approve does.
    void (async () => {
      try { if (root.mode === 'plan') await root.setMode('bypassPermissions'); }
      catch (e) { onError(`approving the root conductor's plan failed: ${errMsg(e)}`); return; }
      await send(buildApprovePrompt(undefined));
    })();
  };
}
