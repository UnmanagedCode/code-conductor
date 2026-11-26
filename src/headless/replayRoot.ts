// A replay's resumed root under `--ui interact` / `--ui full`
// (src/headless/replay.ts): the root's tool asks get the headless no-person
// answers (src/headless/rootPolicy.ts), as in a live run. Only the chosen
// session's live instance is watched; workers and other sessions route their
// asks as usual. Each instance of the root (a re-resume is a new one) gets its
// own answerer. Nothing is sent on resume itself: the run fragment went with
// the run's first prompt.

import { rootAskAnswerer } from './rootPolicy.ts';
import type { InstanceManagerLike, InstanceSummary } from '../instanceTypes.ts';

export interface ReplayRootDeps {
  instances: Pick<InstanceManagerLike, 'on' | 'off' | 'liveForSession'>;
  // The replay's public session id.
  sessionId: string;
  log: (line: string) => void;
}

export function watchReplayRoot({ instances, sessionId, log }: ReplayRootDeps): { detach(): void } {
  const answerers = new Map<string, (s: InstanceSummary) => void>();
  const onStatus = (s: InstanceSummary): void => {
    if (s.sessionId !== sessionId) return;
    const inst = instances.liveForSession(sessionId);
    if (!inst || inst.id !== s.id) return;
    let answer = answerers.get(inst.id);
    if (!answer) {
      answer = rootAskAnswerer(inst, (m) => log(`headless: ${m}`));
      answerers.set(inst.id, answer);
    }
    answer(s);
  };
  instances.on('status', onStatus);
  return { detach: () => { instances.off('status', onStatus); answerers.clear(); } };
}
