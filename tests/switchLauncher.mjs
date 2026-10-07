import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
import { ControllableLauncher } from './controllableLauncher.mjs';

// The in-process fake for ordinary launches; a queued `plan` entry makes the NEXT
// launch a ControllableLauncher child instead — `{crash: stderr}` crashes at
// startup with that stderr, `{failSpawn: message}` never starts at all. Shared by
// the model-switch suites, whose failure paths need exactly one launch to die.
//
// This module is NOT named `*.test.mjs`, so run.mjs's discover() ignores it.
export class SwitchLauncher {
  inProcess = true;
  constructor() { this.inner = new InProcessClaudeLauncher(); this.ctl = new ControllableLauncher(); this.plan = []; this.count = 0; }
  launch(spec) {
    this.count += 1;
    const next = this.plan.shift();
    if (!next) return this.inner.launch(spec);
    if (next.failSpawn) this.ctl.failNext = next.failSpawn;
    else if (next.crash) this.ctl.crashNext(next.crash);
    return this.ctl.launch(spec);
  }
}
