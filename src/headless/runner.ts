// The headless run: spawn one New-conductor root, give it the prompt, answer
// the root's own asks with no person present, and resolve once the root and its
// whole owned tree are quiescent (InstanceManager.isTreeQuiescent) for the
// settle window. Workers and section leads keep routing their asks to their
// owners; only the root is watched. Nothing is torn down here: the entry writes
// the result and exits, leaving state as a normal cc death leaves it.

import { newConductorSpawnBody } from '../../shared/newConductor.ts';
import { buildApprovePrompt } from '../../shared/planApproval.ts';
import { spawnFromBody } from '../spawnRequest.ts';
import { IDLE_DRAIN_SETTLE_MS } from '../idleSubscriptions.ts';
import { flushCostWrites, getSessionStats } from '../costTracking.ts';
import { reconstructMessages } from '../mcp/messageReconstruction.ts';
import { HEADLESS_FRAGMENT, HEADLESS_QUESTION_ANSWER } from './fragment.ts';
import { EXIT_CODES, signalExitCode, type HeadlessReason, type HeadlessResult } from './result.ts';
import type { HeadlessMode } from './args.ts';
import type { InstanceLike, InstanceManagerLike, InstanceSummary } from '../instanceTypes.ts';

// How long a signal waits on the root's forced interrupt before the run ends anyway.
const INTERRUPT_WAIT_MS = 5_000;
const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface RunHeadlessInput {
  instances: InstanceManagerLike;
  prompt: string;
  mode: HeadlessMode;
  clock?: { now(): number };
  signals?: SignalSource;
  // Handed the run's handle synchronously, before the spawn starts.
  expose?: (handle: RunHandle) => void;
}

// The root's session facts so far: null until the root is spawned.
export interface RunFacts {
  sessionId: string | null;
  text: string | null;
  durationMs: number;
}

// What the entry's catch-all reads (src/headless/entry.ts) to keep a result's
// session facts, and the first signal's cost read (null until a signal).
export interface RunHandle {
  facts(): RunFacts | null;
  signalCostRead(): Promise<number | null> | null;
  // Stop listening (signals, manager events) without resolving: the entry has
  // written a result of its own.
  detach(): void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The root's last top-level assistant text, or null.
function lastText(root: InstanceLike): string | null {
  const msgs = reconstructMessages(root.ringSnapshot(), false).filter((m) => m.text.trim() !== '');
  return msgs.at(-1)?.text ?? null;
}

export function runHeadless({ instances, prompt, mode, clock = Date, signals = process, expose }: RunHeadlessInput): Promise<HeadlessResult> {
  const t0 = clock.now();
  // The root plus its spawned tree, from costs.jsonl (claude-backend turns
  // only). Best-effort: a failed read costs the result its costUsd, nothing
  // else, and is logged once per run however many reads fail.
  let costWarned = false;
  const rolledCost = async (r: InstanceLike | null): Promise<number | null> => {
    const sid = r?.sessionId;
    if (!sid) return null;
    try {
      await flushCostWrites();
      return (await getSessionStats(sid)).rolled.cost_usd;
    } catch (e) {
      if (!costWarned) console.warn(`headless: reading the run's cost failed, costUsd is null: ${errText(e)}`);
      costWarned = true;
      return null;
    }
  };
  let root: InstanceLike | null = null;
  let ending = false;
  let delivered = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let answeredAsks = 0;
  let signalled: NodeJS.Signals | null = null;
  // The cost as read when the first signal arrived, once that read finished — what a second signal reports.
  let firstSignalCost: number | null = null;
  let firstSignalRead: Promise<number | null> | null = null;
  let resolveResult!: (r: HeadlessResult) => void;
  const result = new Promise<HeadlessResult>((r) => { resolveResult = r; });

  const snapshot = (reason: HeadlessReason, exitCode: number, error: string | null, costUsd: number | null): HeadlessResult => ({
    reason,
    exitCode,
    sessionId: root?.sessionId ?? null,
    text: root ? lastText(root) : null,
    costUsd,
    durationMs: root ? clock.now() - t0 : null,
    error,
  });

  const clearSettle = () => { if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; } };

  function detach(): void {
    clearSettle();
    instances.off('status', onStatus);
    instances.off('subscription_changed', evaluate);
    for (const s of SIGNALS) signals.off(s, onSignal);
  }

  const deliver = (r: HeadlessResult) => {
    if (delivered) return;
    delivered = true;
    detach();
    resolveResult(r);
  };

  // Anything the runner's own async paths throw: the run still ends, as a
  // signal if one was seen.
  const failRun = (e: unknown) => {
    ending = true;
    const error = `the headless run failed: ${errText(e)}`;
    if (signalled) deliver(snapshot('signal', signalExitCode(signalled), `interrupted by ${signalled}; then ${error}`, firstSignalCost));
    else deliver(snapshot('conductor_error', EXIT_CODES.conductor_error, error, null));
  };

  // The one terminal path for everything but a repeated signal.
  const end = async (reason: Exclude<HeadlessReason, 'signal'>, error: string | null) => {
    if (ending) return;
    ending = true;
    clearSettle();
    deliver(snapshot(reason, EXIT_CODES[reason], error, await rolledCost(root)));
  };

  function evaluate(): void {
    if (!root || ending) return;
    if (!instances.isTreeQuiescent(root.id)) { clearSettle(); return; }
    settleTimer ??= setTimeout(onSettle, IDLE_DRAIN_SETTLE_MS);
  }

  function onSettle(): void {
    settleTimer = null;
    if (!root || ending || !instances.isTreeQuiescent(root.id)) return;
    const done = root.summary().lastTurnError === true
      ? end('conductor_error', "the root conductor's last turn ended in an error")
      : end('completed', null);
    done.catch(failRun);
  }

  const send = (text: string) => root!.promptOrQueueSteer(text, [], { author: 'human' })
    .catch((e: unknown) => end('conductor_error', `answering the root conductor failed: ${errText(e)}`));

  // A tool ask on the root, once per ask: there is no person to answer it.
  function answerAsk(s: InstanceSummary): void {
    const asks = s.liveAsks ?? 0;
    if (s.awaitingUserSource !== 'tool' || asks <= answeredAsks) return;
    answeredAsks = asks;
    if (s.awaitingUser === 'question') { send(HEADLESS_QUESTION_ANSWER).catch(failRun); return; }
    if (s.awaitingUser !== 'plan') return;
    // The plan the auto-approve rule did not take (code mode, or out of plan
    // mode): approved as the UI's Approve does.
    const r = root!;
    void (async () => {
      try { if (r.mode === 'plan') await r.setMode('bypassPermissions'); }
      catch (e) { await end('conductor_error', `approving the root conductor's plan failed: ${errText(e)}`); return; }
      await send(buildApprovePrompt(undefined));
    })().catch(failRun);
  }

  function rootDied(status: string): void {
    const cause = root?.sessionId ? instances.exitCauseFor(root.sessionId) : null;
    const detail = cause ? ` (code ${cause.code}, signal ${cause.signal}${cause.stderrTail ? `; stderr: ${cause.stderrTail.trim()}` : ''})` : '';
    end('conductor_error', `the root conductor ${status} before the run completed${detail}`).catch(failRun);
  }

  function onStatus(s: InstanceSummary): void {
    if (!root || ending) return;
    if (s.id === root.id) {
      if (s.status === 'exited' || s.status === 'crashed') { rootDied(s.status); return; }
      answerAsk(s);
    }
    evaluate();
  }

  function onSignal(signal: NodeJS.Signals): void {
    const exitCode = signalExitCode(signal);
    const error = `interrupted by ${signal}`;
    // A second signal, or one landing while the run is already ending: now.
    if (ending) { deliver(snapshot('signal', exitCode, error, firstSignalCost)); return; }
    ending = true;
    signalled = signal;
    clearSettle();
    const r = root;
    firstSignalRead = rolledCost(r).then((c) => { firstSignalCost = c; return c; });
    void (async () => {
      if (r) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          r.interrupt({ force: true }).catch(() => {}),
          new Promise<void>((res) => { timer = setTimeout(res, INTERRUPT_WAIT_MS); }),
        ]);
        clearTimeout(timer);
      }
      deliver(snapshot('signal', exitCode, error, await rolledCost(r)));
    })().catch(failRun);
  }

  for (const s of SIGNALS) signals.on(s, onSignal);
  expose?.({
    facts: () => (root ? { sessionId: root.sessionId ?? null, text: lastText(root), durationMs: clock.now() - t0 } : null),
    signalCostRead: () => firstSignalRead,
    detach,
  });

  void (async () => {
    let spawned: InstanceLike;
    try {
      spawned = await spawnFromBody(instances, {
        ...newConductorSpawnBody(mode),
        ...(mode === 'plan' ? { autoApprovePlan: true } : {}),
      });
    } catch (e) {
      await end('conductor_error', `spawning the root conductor failed: ${errText(e)}`);
      return;
    }
    if (ending) return;
    root = spawned;
    instances.on('status', onStatus);
    instances.on('subscription_changed', evaluate);
    if (spawned.status === 'exited' || spawned.status === 'crashed') { rootDied(spawned.status); return; }
    try {
      await spawned.promptOrQueueSteer(`${HEADLESS_FRAGMENT}\n\n${prompt}`, [], { author: 'human' });
    } catch (e) {
      await end('conductor_error', `prompting the root conductor failed: ${errText(e)}`);
      return;
    }
    evaluate();
  })().catch(failRun);

  return result;
}
