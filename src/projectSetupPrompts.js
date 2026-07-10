// Project setup prompts — one-time instructions a plugin can offer at project
// creation, folded into the new project's first agent turn. Unlike project
// conventions (which snapshot into CLAUDE.md), a setup prompt is persisted to
// the project's project.json at creation and consumed as the opening prompt on
// the first fresh spawn (see src/instances.js create()).
//
// Setup prompts are plugin-only (no core seeds). The plugin host is the source;
// it is injected after construction (server.js wires it) to avoid an import
// cycle. Default is a no-op so tests/imports without plugins work.

let pluginSetupPromptsProvider = async () => [];
export function setPluginSetupPromptsProvider(fn) { pluginSetupPromptsProvider = fn ?? (async () => []); }

// Enabled+ok plugins' offered setup prompts: [{ pluginId, name, description }]
// (the text body is omitted — callers select by pluginId, compose resolves it).
export async function listSetupPrompts() {
  const offers = await pluginSetupPromptsProvider();
  return offers.map(({ pluginId, name, description }) => ({ pluginId, name, description }));
}

// Resolve selected plugin ids to a single markdown block folded into the first
// agent turn. Unknown/unavailable id → 400. Empty list → '' (no prompt).
export async function composeSetupPrompt(pluginIds) {
  if (!Array.isArray(pluginIds) || pluginIds.length === 0) return '';
  const offers = await pluginSetupPromptsProvider();
  const byId = new Map(offers.map(o => [o.pluginId, o]));
  const parts = [];
  for (const id of pluginIds) {
    const offer = byId.get(id);
    if (!offer) {
      const err = new Error(`unknown or unavailable setup prompt '${id}'`);
      err.statusCode = 400;
      throw err;
    }
    parts.push(offer.text);
  }
  return parts.join('\n\n');
}
