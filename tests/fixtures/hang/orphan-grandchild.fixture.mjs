// The child itself exits cleanly and its test passes — but it left a GRANDCHILD
// holding the inherited stdio pipe, so the parent's report pipe never closes and
// the run hangs anyway. Only killTree()'s descendant walk clears this; killing
// the direct child alone is not enough.
import test from 'node:test';
import { spawn } from 'node:child_process';

test('orphan-grandchild: spawns a detached holder of our stdio', () => {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
});
