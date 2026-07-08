// Child that forks a grandchild, then serves — proves stop() kills the
// whole process group, not just the leader.
import http from 'node:http';
import { spawn } from 'node:child_process';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, grandchildPid: grandchild.pid }));
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  console.log(`forker listening; grandchild=${grandchild.pid}`);
});
