// A throwaway "old cc": a plugin host in its own process that starts the
// already-enabled fake-plugin, prints {pid, port} as one JSON line and exits
// WITHOUT stopping the backend, which stays detached. A host in this test
// process then adopts it exactly as a restarted cc adopts its predecessor's
// children — with nobody in the dead process left to observe the child's exit.
// PROJECTS_ROOT comes from the environment.
import { createPluginHost } from '../../src/plugins/registry.ts';

const host = createPluginHost();
await host.start('fake-plugin');
const { pid, port } = await host.status('fake-plugin');
process.stdout.write(JSON.stringify({ pid, port }) + '\n', () => process.exit(0));
