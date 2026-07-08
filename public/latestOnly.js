// Guards a repeatedly-refired async fetch against out-of-order resolution.
// refreshInstances() fires on every `{t:'instances'}`/`{t:'status'}` WS
// broadcast, which the server emits on every instance's status change
// app-wide — near-continuous in a busy multi-instance session. Node resolves
// concurrent requests by completion order, not dispatch order, so an
// earlier-dispatched-but-slower GET can resolve AFTER a newer one and
// clobber fresh state with a stale snapshot. latestOnly() tags each call
// with a monotonic token and only applies the result of the most recently
// issued call — a result whose token has been superseded is dropped.
export function latestOnly() {
  let token = 0;
  return async function run(fn, apply) {
    const mine = ++token;
    const result = await fn();
    if (mine === token) apply(result);
  };
}
