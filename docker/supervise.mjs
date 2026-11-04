// Container restart supervisor: `node docker/supervise.mjs <command> [args…]`.
// Runs the command and relaunches it when it exits with the restart code; the
// contract lives in src/restartSupervisor.ts.
import { superviseServer } from '../src/restartSupervisor.ts';

process.title = 'cc-supervisor';
superviseServer({ command: process.argv[2], args: process.argv.slice(3) });
