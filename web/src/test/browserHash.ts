// happy-dom dispatches `hashchange` for history.pushState/replaceState, which a
// browser never does. Imported first in a test file (before anything that loads
// state/route.ts), it stops those events before any app listener hears them;
// a `location.hash =` change still delivers. happy-dom queues one event per
// hash-changing history call, in order, so each is matched by its URL pair.
const pending: { oldURL: string; newURL: string }[] = [];

for (const op of ['pushState', 'replaceState'] as const) {
  const original = history[op].bind(history);
  history[op] = (data: unknown, unused: string, url?: string | URL | null) => {
    const oldURL = location.href;
    const oldHash = location.hash;
    original(data, unused, url);
    if (location.hash !== oldHash) pending.push({ oldURL, newURL: location.href });
  };
}

addEventListener('hashchange', (e) => {
  const head = pending[0];
  if (head && head.oldURL === e.oldURL && head.newURL === e.newURL) {
    pending.shift();
    e.stopImmediatePropagation();
  }
}, true);

export {};
