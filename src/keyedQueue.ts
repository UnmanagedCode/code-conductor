// A per-key promise chain: calls sharing a key run one at a time, in call
// order; calls on different keys run concurrently. In-process only.
//
// A rejection is returned to its own caller and never blocks the next call on
// the key. A key's entry is dropped once its tail settles, so an idle key holds
// nothing.

export type KeyedQueue = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function createKeyedQueue(): KeyedQueue & { size(): number } {
  const tails = new Map<string, Promise<unknown>>();
  const run = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
  return Object.assign(run, { size: () => tails.size });
}
