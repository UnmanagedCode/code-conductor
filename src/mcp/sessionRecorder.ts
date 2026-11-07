// The event log's lifecycle half: turns the manager's session stream into
// `session`, `turn`, `wake` and `config` rows (docs/event-log.md). Watching the
// manager means whichever surface causes an edge — a kill, a crash, a UI resume,
// the WS enforcement toggle, a restart restore — is recorded without that
// surface knowing the log exists.
//
// It writes through `record`, the playbook gate's one append path, so these rows
// and the gate's `call` rows share one serial chain and one projection.

import { isConductorInstance } from '../conduct.ts';
import { normalizePlaybookEnforcement } from '../playbooks.ts';
import type { AppendInput, NewEventRow } from '../eventLog.ts';
import type { Projection } from '../playbookState.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';

const SYSTEM = { type: 'system' } as const;

export function attachSessionRecorder(
  { instances, record, projection }:
  { instances: InstanceManagerLike; record: (input: AppendInput) => Promise<unknown>; projection: () => Projection },
): void {
  // Turn rows cover the sessions a conductor run is made of: conductors and the
  // workers they conduct. A plain UI session's turns are not recorded.
  const turnScoped = (s: { conducted: boolean; project: string }): boolean =>
    s.conducted === true || isConductorInstance({ project: s.project });
  // Sessions with a recorded `turn start` and no `end` yet. Updated synchronously
  // in the listeners, so an exit reads the turn its own death interrupted.
  const inTurn = new Set<string>();

  instances.on('session_launched', ({ sessionId, project, event, cause, actor, playbookEnforcement }) => {
    const launch: NewEventRow = { kind: 'session', actor, subject: sessionId, event, ...(cause ? { cause } : {}) };
    if (!isConductorInstance({ project })) { void record(launch); return; }
    // A conductor's enforcement BIRTH: written when the log holds no level for
    // it yet — read from the log, not per process, so a restart re-launching a
    // conductor records no second birth. Decided in the chain (a thunk), after
    // every earlier row has folded.
    const to = normalizePlaybookEnforcement(playbookEnforcement);
    void record(() => (projection().enforcement.has(sessionId)
      ? launch
      : [launch, { kind: 'config', actor: SYSTEM, subject: sessionId, key: 'enforcement', to }]));
  });

  instances.on('session_exited', ({ sessionId, status, actor }) => {
    const exit: NewEventRow = { kind: 'session', actor, subject: sessionId, event: 'exit', cause: status };
    // A death mid-turn closes the turn first, in the same write, so the two
    // rows are adjacent.
    void record(inTurn.delete(sessionId)
      ? [{ kind: 'turn', actor: SYSTEM, subject: sessionId, event: 'end' }, exit]
      : exit);
  });

  instances.on('turn_started', (t) => {
    if (!turnScoped(t)) return;
    inTurn.add(t.sessionId);
    void record({ kind: 'turn', actor: t.actor, subject: t.sessionId, event: 'start' });
  });

  instances.on('turn_ended', (t) => {
    if (!turnScoped(t)) return;
    inTurn.delete(t.sessionId);
    void record({
      kind: 'turn', actor: SYSTEM, subject: t.sessionId, event: 'end',
      ...(t.stopReason !== undefined ? { stopReason: t.stopReason } : {}),
    });
  });

  instances.on('wake_delivered', ({ callerSessionId, callerProject, targetSessionId, heartbeat }) => {
    // Only a conductor's wakes — what keeps `recipient` a conductor.
    if (!isConductorInstance({ project: callerProject })) return;
    void record({
      kind: 'wake', actor: SYSTEM, subject: targetSessionId, recipient: callerSessionId,
      ...(heartbeat ? { heartbeat: true as const } : {}),
    });
  });

  instances.on('enforcement_changed', ({ sessionId, project, to, actor }) => {
    if (!isConductorInstance({ project })) return;
    // `from` is the level the LOG last recorded (absent if none), and an
    // unchanged level writes nothing — both read in the chain.
    void record(() => {
      const from = projection().enforcement.get(sessionId);
      if (from === to) return null;
      return { kind: 'config', actor, subject: sessionId, key: 'enforcement', ...(from !== undefined ? { from } : {}), to };
    });
  });
}
