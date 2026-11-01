// The lucide icons a plugin's `frontend.icon` may name (docs/plugins.md → frontend.icon); the server validates against it, the web maps it to components.
export const PLUGIN_ICONS = ['git-branch', 'message-square-code', 'package', 'square-kanban', 'square-terminal'] as const;
export type PluginIconName = (typeof PLUGIN_ICONS)[number];
