// Which workers the user has confirmed sending to from their own composer, per browser. Keyed by
// sessionId (permanent across respawn, renew and prune), most recent last.
export const WORKER_SEND_ACK_KEY = 'code-conductor:worker-send-ack';
export const ACK_CAP = 200;

/** The page-lifetime fallback while storage is unavailable. */
const memory = new Set<string>();

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function read(): string[] | null {
  try {
    const raw = storage()?.getItem(WORKER_SEND_ACK_KEY);
    if (raw == null) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return null; }
}

export function isWorkerSendAcked(sid: string): boolean {
  if (memory.has(sid)) return true;
  return read()?.includes(sid) ?? false;
}

export function ackWorkerSend(sid: string): void {
  const list = read();
  if (list === null) { memory.add(sid); return; }
  const next = [...list.filter((x) => x !== sid), sid].slice(-ACK_CAP);
  try { storage()?.setItem(WORKER_SEND_ACK_KEY, JSON.stringify(next)); } catch { memory.add(sid); }
}
