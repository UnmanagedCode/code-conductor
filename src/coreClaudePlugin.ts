import { promises as fs } from 'node:fs';
import path from 'node:path';
import { selfProjectDir } from './projects.ts';

// cc's built-in Claude Code plugin root: the skills cc itself ships, loaded
// into every session it spawns ahead of the enabled cc plugins' roots. Its
// `.claude-plugin/plugin.json` `name` is the skills' namespace
// (`<name>:<skill>`); nothing in code repeats it.
export const CORE_CLAUDE_PLUGIN_ROOT = path.join(selfProjectDir(), 'claude-plugin');

// The `--plugin-dir` list a session launches with: the built-in root first,
// then `pluginDirs` (the enabled plugins' validated roots) in order. A root
// without `.claude-plugin/plugin.json` is a broken install: warned and left
// out, because a broken `--plugin-dir` would stop claude from starting — the
// same rule the plugin roots follow. Never throws.
export async function withCoreClaudePlugin(coreRoot: string, pluginDirs: string[]): Promise<string[]> {
  const manifest = path.join(coreRoot, '.claude-plugin', 'plugin.json');
  try {
    await fs.access(manifest);
  } catch (e) {
    console.warn(`coreClaudePlugin: no ${manifest} (${(e as Error).message}); core skills not loaded`);
    return pluginDirs;
  }
  return [coreRoot, ...pluginDirs];
}
