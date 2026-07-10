// Project scaffolds — one-time project-setup directives a plugin offers at
// creation (e.g. "build a project-local test-harness wrapper"). Unlike project
// conventions (which snapshot into CLAUDE.md), a scaffold is NOT persisted: at
// creation the selected scaffolds are composed into a single orchestrator-
// guidance block that `create_project` RETURNS, for the conductor to fold into
// its first worker brief. Nothing auto-fires.
//
// Scaffolds are plugin-only (no core seeds). The plugin host is the source; it
// is injected after construction (server.js wires it) to avoid an import cycle.
// Default is a no-op so tests/imports without plugins work.

let pluginScaffoldsProvider = async () => [];
export function setPluginScaffoldsProvider(fn) { pluginScaffoldsProvider = fn ?? (async () => []); }

// Enabled+ok plugins' offered scaffolds: [{ slug, name, description, plugin }]
// (namespaced <plugin-id>/<slug>; the directive text is omitted — callers
// select by slug, compose resolves the body).
export async function listProjectScaffolds() {
  const offers = await pluginScaffoldsProvider();
  return offers.map(({ slug, name, description, plugin }) => ({ slug, name, description, plugin }));
}

// Resolve selected namespaced slugs (in selection order) to one orchestrator-
// guidance block the conductor folds into the first worker brief. Unknown/
// unavailable slug → 400. Empty list → '' (no scaffold).
export async function composeScaffold(projectName, slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return '';
  const offers = await pluginScaffoldsProvider();
  const bySlug = new Map(offers.map(o => [o.slug, o]));
  const steps = [];
  for (const slug of slugs) {
    const offer = bySlug.get(slug);
    if (!offer) {
      const err = new Error(`unknown or unavailable scaffold '${slug}'`);
      err.statusCode = 400;
      throw err;
    }
    steps.push(offer.text);
  }
  const numbered = steps.map((t, i) => `${i + 1}) ${t}`).join('\n\n');
  return `Project "${projectName}" was created with these setup steps. Complete them first, before other work:\n\n${numbered}`;
}
