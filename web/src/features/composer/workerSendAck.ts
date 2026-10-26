// Which workers the user has confirmed sending to from their own composer, per browser. Keyed by
// sessionId (permanent across respawn, renew and prune), most recent last.
export const WORKER_SEND_ACK_KEY = 'code-conductor:worker-send-ack';
export const ACK_CAP = 200;

/** The acks of a page whose storage is unusable; the source of truth there. */
const memory = new Set<string>();

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** The stored acks, `[]` for an unparseable or non-array value; null when storage cannot be read at all. */
function read(): string[] | null {
  let raw: string | null | undefined;
  try { raw = storage()?.getItem(WORKER_SEND_ACK_KEY); } catch { return null; }
  if (raw === undefined) return null;
  if (raw === null) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function isWorkerSendAcked(sid: string): boolean {
  return memory.has(sid) || (read()?.includes(sid) ?? false);
}

export function ackWorkerSend(sid: string): void {
  const list = read();
  if (list === null) { memory.add(sid); return; }
  const next = [...list.filter((x) => x !== sid), sid].slice(-ACK_CAP);
  try { storage()!.setItem(WORKER_SEND_ACK_KEY, JSON.stringify(next)); } catch { memory.add(sid); }
}
