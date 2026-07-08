import net from 'node:net';

// Allocate a free TCP port by binding to 0 and reading the assigned port,
// then closing. There is a small TOCTOU window between close and the child
// binding it: another process can grab the same ephemeral port first, in
// which case the child's listen() fails with EADDRINUSE and it exits hard.
// supervisor.js retries on a freshly allocated port when it detects that.
export function allocatePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Resolve once a TCP connection to localhost:port succeeds, or reject after
// `timeoutMs`. Polls every `intervalMs`.
export function waitForPort(port, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) reject(new Error(`port ${port} not listening within ${timeoutMs}ms`));
        else setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
