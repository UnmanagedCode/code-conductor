// Pass-through wrapper for the code-mutant plugin's runner: resolves
// `<projectsRoot>/.plugins/code-mutant/mutate.mjs` via ../pluginDir.mjs and runs
// it with this process's arguments, cwd (the runner finds the repo root from
// it), stdio and exit status unchanged.
//
// SIGINT sent to this pid alone does nothing: the wrapper ignores it so the
// runner can restore the tree. Ctrl-C at a terminal and a process-group kill
// both reach the runner — to interrupt a run, signal the group, not the pid.
//
//   node harness/mutation/run.mjs <runner args…>

import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolvePluginDir } from '../pluginDir.mjs';

let runner;
try {
  runner = path.join(resolvePluginDir('code-mutant'), 'mutate.mjs');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const child = spawn(process.execPath, [runner, ...process.argv.slice(2)], { stdio: 'inherit' });

// A tty's SIGINT already reaches the child through the process group; staying
// alive lets the runner restore the tree and report its own exit. SIGTERM and
// SIGHUP are sent to this pid alone, so they are forwarded.
const onInt = () => {};
const forward = sig => child.kill(sig);
process.on('SIGINT', onInt);
process.on('SIGTERM', forward);
process.on('SIGHUP', forward);

child.on('error', err => {
  console.error(`harness: cannot run ${runner}: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', forward);
    process.off('SIGHUP', forward);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code);
});
