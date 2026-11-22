// The `stream-json` output (docs/protocol/headless.md → Output formats): the
// CLI stdout lines the manager's `stdout_line` tap relays, filtered to the run's
// root (or, with `--include-workers`, to every session in its tree) and written
// to the sink as they arrive. Root-only lines go out byte-exact; tree lines carry
// cc's identity labels. The CLIs are never paused: past `capBytes` unflushed
// bytes the stream stops and fails the run instead.

import { isConductorInstance } from '../conduct.ts';
import type { InstanceLike, InstanceManagerLike, StdoutLine } from '../instanceTypes.ts';
import { errMsg } from '../../shared/basics.ts';

export const STREAM_STDOUT_CAP_BYTES = 256 * 1024 * 1024;

export interface StreamSink {
  write(chunk: string): unknown;
  // The bytes written but not yet flushed to the consumer.
  buffered(): number;
}

export interface StreamLabels {
  cc_session_id: string | null;
  cc_parent_session_id: string | null;
  cc_root_session_id: string | null;
  cc_role: 'conductor' | 'worker';
  cc_project: string;
  cc_worktree: string | null;
}

type StreamManager = Pick<InstanceManagerLike, 'on' | 'off' | 'inRunTree'>;

export interface HeadlessStreamInput {
  instances: StreamManager;
  includeWorkers: boolean;
  sink: StreamSink;
  // Called at most once, from a microtask — never inside the line handler.
  onFail: (message: string) => void;
  capBytes?: number;
}

export interface HeadlessStream {
  setRoot(root: InstanceLike): void;
  close(): void;
}

const NOT_JSON = Symbol('not json');

// One labelled line, no trailing newline. An object line keeps the CLI's bytes
// up to its closing brace and gains the labels after its own keys (so a CLI
// `cc_*` key loses under JSON.parse's last-wins rule); anything else is wrapped.
export function labelLine(line: string, labels: StreamLabels): string {
  let v: unknown;
  try { v = JSON.parse(line); } catch { v = NOT_JSON; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return JSON.stringify({ type: 'cc_raw', line, ...labels });
  // JSON's own whitespace: once trimmed, a parsed object's text ends in `}`.
  const body = line.replace(/[ \t\n\r]+$/, '');
  const frag = JSON.stringify(labels).slice(1, -1);
  return `${body.slice(0, -1)}${Object.keys(v).length ? ',' : ''}${frag}}`;
}

function labelsOf(inst: InstanceLike, root: InstanceLike): StreamLabels {
  return {
    cc_session_id: inst.sessionId,
    cc_parent_session_id: inst.parentSessionId ?? null,
    cc_root_session_id: root.sessionId,
    cc_role: isConductorInstance(inst) ? 'conductor' : 'worker',
    cc_project: inst.project,
    cc_worktree: inst.worktree?.worktreeName ?? null,
  };
}

export function createHeadlessStream({ instances, includeWorkers, sink, onFail, capBytes = STREAM_STDOUT_CAP_BYTES }: HeadlessStreamInput): HeadlessStream {
  let root: InstanceLike | null = null;
  let stopped = false;
  let failed = false;
  let pending: StdoutLine[] = [];
  // --include-workers: an admitted session streams for the rest of the run; a
  // rejected one is not re-walked until a status or ownership change.
  const admitted = new Set<string>();
  const rejected = new Set<string>();
  const clearRejected = () => { rejected.clear(); };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    pending = [];
    instances.off('stdout_line', onLine);
    if (includeWorkers) {
      instances.off('status', clearRejected);
      instances.off('subscription_changed', clearRejected);
    }
  };

  const fail = (message: string) => {
    stop();
    if (failed) return;
    failed = true;
    queueMicrotask(() => onFail(message));
  };

  const member = (inst: InstanceLike, r: InstanceLike): boolean => {
    if (!includeWorkers) return inst.id === r.id;
    if (admitted.has(inst.id)) return true;
    if (rejected.has(inst.id)) return false;
    if (instances.inRunTree(r.id, inst)) { admitted.add(inst.id); return true; }
    rejected.add(inst.id);
    return false;
  };

  const handle = ({ instance, line }: StdoutLine, r: InstanceLike) => {
    if (!member(instance, r)) return;
    sink.write(includeWorkers ? `${labelLine(line, labelsOf(instance, r))}\n` : `${line}\n`);
    const n = sink.buffered();
    if (n > capBytes) fail(`stdout consumer fell behind: ${n} bytes unflushed, over the ${capBytes}-byte cap (STREAM_STDOUT_CAP_BYTES); streaming stopped`);
  };

  // Never throws into the emitter: the Instance parses the line after this returns.
  function onLine(entry: StdoutLine): void {
    if (stopped) return;
    try {
      if (!root) { pending.push(entry); return; }
      handle(entry, root);
    } catch (e) {
      fail(`the headless stream failed: ${errMsg(e)}`);
    }
  }

  instances.on('stdout_line', onLine);
  if (includeWorkers) {
    instances.on('status', clearRejected);
    instances.on('subscription_changed', clearRejected);
  }

  return {
    setRoot(r: InstanceLike): void {
      if (stopped || root) return;
      root = r;
      const queued = pending;
      pending = [];
      try {
        for (const entry of queued) {
          if (stopped) return;
          handle(entry, r);
        }
      } catch (e) {
        fail(`the headless stream failed: ${errMsg(e)}`);
      }
    },
    close: stop,
  };
}
