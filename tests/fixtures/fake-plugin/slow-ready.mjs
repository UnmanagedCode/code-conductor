// Slow-ready child: binds $PORT only after a delay (readiness must wait,
// not give up). Delay overridable for tests via SLOW_READY_MS.
import http from 'node:http';

const delay = Number(process.env.SLOW_READY_MS ?? 2000);
setTimeout(() => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
    console.log('slow-ready listening');
  });
}, delay);
