// The worker-identity tests' fleet: two live conductors with distinct colours, a hand-spawned
// session, and conducted workers in each ownership state.
import { appStore } from '@/state/app';
import { conductorColor } from '@shared/conductorColor';
import { A, B, ALPHA, conductor, hand, inst, worker } from '@/test/sidebarFleet';

export const C1 = A;
export const C2 = B;
export const C1_LABEL = ALPHA;
export const C2_LABEL = 'Bravo';
/** An inactive conductor that has only a disk row, and an owner no list carries. */
export const CI = 'cond-inactive';
export const CI_LABEL = 'india: an old run';
export const CGONE = 'cond-gone-0000';

if (conductorColor(C1) === conductorColor(C2)) throw new Error('workerFleet: the two conductors need distinct colours');

export const fleet = () => ({
  c1: conductor(C1, { title: C1_LABEL }),
  c2: conductor(C2, { title: C2_LABEL }),
  h: hand('h-one', 'demo', null, { title: 'Hand' }),
  w1: worker('w-one', C1, 'demo', null, { title: 'Wone' }),
  w2: worker('w-two', C2, 'demo', null, { title: 'Wtwo' }),
  wu: worker('w-unknown', null as any, 'demo', null, { title: 'Wunk' }),
  wi: worker('w-inactive', CI, 'demo', null, { title: 'Wina' }),
  wa: worker('w-absent', CGONE, 'demo', null, { title: 'Wabs' }),
});

export type Fleet = ReturnType<typeof fleet>;

/** Seeds the store with the fleet (instances in the order c1, c2, h, w1, w2, wu, wi, wa) and the inactive conductor's disk row. */
export function seedWorkerFleet(f: Fleet = fleet(), extra: Record<string, any>[] = []) {
  appStore.set({
    connection: 'open', activeId: null,
    instances: [...Object.values(f), ...extra] as any,
    conductSessions: [{ sessionId: CI, firstPrompt: CI_LABEL, lastActivity: 5 }] as any,
  });
  return f;
}
export { inst };
