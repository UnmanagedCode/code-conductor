import net from 'node:net';

// Allocate a free TCP port by binding to 0 and reading the assigned port,
// then closing. There is a small TOCTOU window between close and the child
// binding it: another process can grab the same ephemeral port first, in
// which case the child's listen() fails with EADDRINUSE and it exits hard.
// supervisor.ts retries on a freshly allocated port when it detects that.
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('allocatePort: no port assigned')));
      }
    });
  });
}

// One-shot connect probe: true if something accepted on localhost:port, false
// on any error. The socket is destroyed on both paths — a probe that leaves an
// established connection behind holds the event loop open (and `server.close()`
// on the other end cannot reclaim it).
export function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

// Resolve once a TCP connection to localhost:port succeeds, or reject after
// `timeoutMs`. Polls every `intervalMs`.
export function waitForPort(port: number, { timeoutMs = 30000, intervalMs = 200 }: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      if (await tcpOpen(port)) return resolve();
      if (Date.now() >= deadline) reject(new Error(`port ${port} not listening within ${timeoutMs}ms`));
      else setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

export function pidAlive(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
