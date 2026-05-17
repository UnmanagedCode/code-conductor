import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildRoutes } from './src/routes.js';
import { InstanceManager } from './src/instances.js';
import { attachWsHub } from './src/wsHub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ withInstances = true } = {}) {
  const app = express();
  const instances = withInstances ? new InstanceManager() : null;

  app.use('/api', buildRoutes({ instances }));
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  if (instances) attachWsHub({ wss, instances });

  return { app, server, instances, wss };
}

export async function start({ port = 8787, host = '127.0.0.1' } = {}) {
  const { server, instances } = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  // Instance subprocesses need the actual bound port to construct the
  // PreToolUse http hook URL — feed it back into the manager now that
  // listen has resolved (port may have been auto-assigned via 0).
  if (instances) instances.setServerPort(addr.port);
  return { server, instances, port: addr.port, host: addr.address };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  start({ port, host }).then(({ port, host }) => {
    console.log(`claude-orch-app listening on http://${host}:${port}`);
  }).catch(e => {
    console.error('failed to start:', e);
    process.exit(1);
  });
}
