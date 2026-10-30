import type http from 'node:http';
import type { Duplex } from 'node:stream';

// The cross-site WebSocket hijacking guard on every upgrade cc accepts.
// Contract: docs/protocol.md → Handshake: Origin check.

// Distinct refused (Origin, Host) pairs remembered so each warns once; both
// values are request-chosen, so the memo is bounded (oldest pair evicted).
export const WARNED_PAIRS_CAP = 64;

/**
 * Whether an upgrade's headers pass the Origin check: no Origin (a non-browser client) passes; otherwise
 * Origin must be an exactly-serialized http(s) origin and the Host header, read under Origin's scheme,
 * must be a bare host[:port] whose host:port (lowercased, default port dropped) equals Origin's.
 */
export function upgradeOriginAllowed(headers: http.IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (origin === undefined) return true;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  if ((o.protocol !== 'http:' && o.protocol !== 'https:') || o.origin !== origin) return false;
  const host = headers.host;
  if (!host) return false;
  let h: URL;
  try { h = new URL(`${o.protocol}//${host}`); } catch { return false; }
  if (h.username || h.password || h.pathname !== '/' || h.search || h.hash) return false;
  return h.host === o.host;
}

/**
 * `admit(req, socket)` is true for an upgrade that passes `upgradeOriginAllowed`; otherwise it writes a raw
 * 403, destroys the socket, warns once per distinct (Origin, Host) pair, and is false.
 */
export function createUpgradeOriginGuard({ log = console }: { log?: Pick<Console, 'warn'> } = {}) {
  const warned = new Set<string>();
  return function admit(req: http.IncomingMessage, socket: Duplex): boolean {
    if (upgradeOriginAllowed(req.headers)) return true;
    try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch { /* gone */ }
    socket.destroy();
    const { origin, host } = req.headers;
    const key = JSON.stringify([origin, host]);
    if (!warned.has(key)) {
      if (warned.size >= WARNED_PAIRS_CAP) warned.delete(warned.values().next().value as string);
      warned.add(key);
      log.warn(`websocket upgrade refused: Origin ${JSON.stringify(origin)} does not match Host ${JSON.stringify(host ?? null)} (a proxy in front of cc must forward Host unchanged)`);
    }
    return false;
  };
}
