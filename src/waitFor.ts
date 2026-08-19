// One promise shape for "settle when a listener-driven predicate fires, or on a
// timeout". Its callers (see this module's importers) differed only in which
// listeners they attach and whether a timeout resolves or rejects — and each
// hand-rolled its own clearTimeout + off() teardown on BOTH paths. This owns the
// teardown once: exactly one cleanup, on whichever of settle/fail/timeout fires
// first, and never twice.
//
// Scoped deliberately to LISTENER-driven waits. The two polling loops in this
// codebase (plugins/registry.ts `waitSettled`, plugins/supervisor.ts `poll`) have
// no emitter and nothing to detach, so the whole value of this helper is nil for
// them — they stay as they are.

export interface WaitForSpec<T> {
  // Already-satisfied fast path, checked BEFORE any listener is attached. Return
  // { value } to resolve immediately, or null to wait. Boxed rather than
  // `T | undefined` because T is legitimately nullable at one call site.
  initial?: () => { value: T } | null;
  // Attach listeners; return a teardown that detaches everything it attached.
  // `settle`/`fail` are idempotent and each runs the teardown exactly once.
  subscribe: (settle: (value: T) => void, fail: (err: Error) => void) => () => void;
  timeoutMs: number;
  // A timeout's disposition: return a value to resolve with, or an Error to
  // reject with. (No call site's T is itself an Error.)
  onTimeout: () => T | Error;
}

export function waitFor<T>(spec: WaitForSpec<T>): Promise<T> {
  const pre = spec.initial?.() ?? null;
  if (pre) return Promise.resolve(pre.value);
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let teardown: (() => void) | null = null;
    const timer = setTimeout(() => {
      const r = spec.onTimeout();
      if (r instanceof Error) fail(r); else settle(r as T);
    }, spec.timeoutMs);
    function finish(): boolean {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      if (teardown) teardown();   // null only if subscribe() settled synchronously
      return true;
    }
    function settle(v: T): void { if (finish()) resolve(v); }
    function fail(e: Error): void { if (finish()) reject(e); }
    teardown = spec.subscribe(settle, fail);
    // A synchronous settle inside subscribe() ran finish() before `teardown` was
    // assigned — detach now, or those listeners leak.
    if (done) teardown();
  });
}
