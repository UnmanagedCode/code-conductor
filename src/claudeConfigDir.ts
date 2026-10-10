// THE CLI'S OWN CONFIG DIRECTORY on this machine — `~/.claude` unless the host
// overrode it. Every cc reader of the CLI's state resolves through here rather
// than spelling `~/.claude`, because the CLI's own resolution honours the
// variable and a reader that did not would be looking at a directory the CLI is
// not writing.
//
// NOT the directory a remote-backed worker is pointed at: that one is cc-owned,
// per remote, and comes from `remoteConfigDir()` (src/projects.ts). This is the
// SOURCE the farm links into, and the directory a LOCAL session keeps using
// untouched.
//
// LEAF MODULE — node builtins ONLY: the e2e harness (web/e2e/harness/) imports
// it to find the live credentials without loading the rest of src/.

import os from 'node:os';
import path from 'node:path';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}
