// Pending attachments per session, at module scope: leaving the session view (Settings or another
// full-page view) unmounts the composer, and a list must still be there when it comes back. The null
// key holds a spawning instance's list, before it has a session id. The store owns each preview's
// object URL: removing an attachment or discarding a list revokes it, and nothing else does.
import { createStore } from '@/state/createStore';

export type Pending = {
  id: number;
  name: string;
  size: number;
  mediaType: string;
  isImage: boolean;
  objectUrl?: string;
  dataBase64?: string;
  error?: string;
};

/** A session id, or null for a spawning instance that has none yet. */
type Key = string | null;
type List = readonly Pending[];

export const NO_ATTACHMENTS: List = Object.freeze([]);

const store = createStore<{ lists: ReadonlyMap<Key, List> }>({ lists: new Map() });

const listOf = (key: Key): List => store.get().lists.get(key) ?? NO_ATTACHMENTS;
const revoke = (list: List) => { for (const a of list) if (a.objectUrl) URL.revokeObjectURL(a.objectUrl); };
function put(key: Key, list: List) {
  store.set((s) => {
    const lists = new Map(s.lists);
    if (list.length) lists.set(key, list);
    else lists.delete(key);
    return { lists };
  });
}

export const attachmentStore = {
  /** Read with `useStore(attachmentStore.store, (s) => s.lists.get(key) ?? NO_ATTACHMENTS)`. */
  store,
  add(key: Key, added: Pending[]) {
    put(key, [...listOf(key), ...added]);
  },
  /** Lands an encode in the list it was added to, whichever session shows now; a no-op once the attachment was removed, sent or discarded. */
  settle(key: Key, id: number, patch: Pick<Pending, 'dataBase64' | 'error'>) {
    const list = listOf(key);
    if (list.some((a) => a.id === id)) put(key, list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  },
  remove(key: Key, id: number) {
    const list = listOf(key);
    revoke(list.filter((a) => a.id === id));
    put(key, list.filter((a) => a.id !== id));
  },
  /** Revokes a list's previews and drops it: a send, a prefill, or a spawning instance's list once a session shows. */
  discard(key: Key) {
    revoke(listOf(key));
    put(key, []);
  },
};
