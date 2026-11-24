// A throwaway "old cc": builds a supervisor, starts the fake-plugin backend,
// prints {pid, port, log} as one JSON line and exits WITHOUT stopping the
// backend — leaving it detached, with whatever stdio the supervisor gave it,
// and nobody on the other end. argv[2] is the log directory.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupervisor } from '../../src/plugins/supervisor.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const logDir = process.argv[2];
const log = { current: path.join(logDir, 'backend.log'), previous: path.join(logDir, 'backend.prev.log') };

const sup = createSupervisor();
const rec = await sup.start({
  id: 'fake-plugin',
  manifest: { backend: { start: 'node server.mjs', healthPath: '/health' } },
  cwd: path.join(here, 'fake-plugin'),
  log,
});
for (let i = 0; i < 200 && sup.runtime('fake-plugin')?.status === 'starting'; i++) {
  await new Promise((r) => setTimeout(r, 50));
}
if (sup.runtime('fake-plugin')?.status !== 'ready') {
  console.error('backend did not become ready');
  process.exit(2);
}
process.stdout.write(JSON.stringify({ pid: rec.pid, port: rec.port, log: log.current }) + '\n', () => process.exit(0));
