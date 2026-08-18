import { headSha } from './supervisor.ts';
import type { PluginManifest, ManifestSource } from './manifest.ts';

// The PluginRow view-model: the projection GET /api/plugins serializes verbatim
// and public/pluginManager.js + public/appSwitcher.js read field by field.
//
// A pure projection — it writes nothing and closes over nothing, so every input
// is passed in and no shared mutable state crosses the boundary. The registry
// gathers those inputs (it owns discovery, the runtime state map and the
// active-version resolution that self-heals a dead worktree pin) and calls this.
//
// The field set is pinned by tests/plugins-row-shape.test.mjs.

export interface PluginRow {
  id: string | null;
  name: string;
  project: string;
  version: string | null;
  state: string;
  enabled: boolean;
  activeVersion: ManifestSource;
  manifestSource: ManifestSource;
  hasBackend: boolean;
  hasFrontend: boolean;
  navLabel: string | null;
  frontendPath: string | null;
  hasMcp: boolean;
  conventions: Array<{ slug: string; name: string; description: string; hasScaffold: boolean }>;
  roles: Array<{ slug: string; name: string }>;
  port: number | null;
  pid: number | null;
  startedAt: string | null;
  gitHead: string | null;
  stale: boolean;
  errors: string[];
  crashTail: string | null;
}

export interface PluginRowInput {
  // The discovered entry, narrowed to what the projection reads.
  entry: {
    id: string | null;
    project: string;
    dir: string;
    manifest: PluginManifest | null;
    manifestSource?: ManifestSource;
    discoveryState: 'ok' | 'invalid' | 'incompatible' | 'conflict';
    errors: string[];
  };
  // The persisted record, the in-memory runtime state and the runtime record —
  // null when the id is unknown to that owner (or absent entirely).
  reg: { enabled: boolean } | null;
  runtime: { status: string; tail: string | null } | null;
  record: { port: number; pid: number; startedAt: string; gitHead: string | null } | null;
  // Resolved (and, where needed, self-healed) by the caller.
  activeVersion: ManifestSource;
  // The checkout the plugin actually runs from — the worktree path for a
  // worktree-pinned plugin, else the discovered project dir.
  cwd: string;
}

export async function buildPluginRow({ entry, reg, runtime, record, activeVersion, cwd }: PluginRowInput): Promise<PluginRow> {
  const id = entry.id;
  const hasBackend = !!entry.manifest?.backend;
  let state: string;
  if (entry.discoveryState !== 'ok') state = entry.discoveryState;
  else if (!reg?.enabled) state = reg ? 'disabled' : 'discovered';
  // A backendless (conventions-only) plugin has no process lifecycle — it is
  // simply 'enabled', never 'stopped', so the UI shows no (broken) Start button.
  else if (!hasBackend) state = 'enabled';
  else state = runtime?.status ?? 'stopped';
  // Staleness: only worth a git spawn for a currently-running plugin — the
  // running child's code may have moved past the sha it was started at.
  let stale = false;
  if (state === 'ready' && record?.gitHead) {
    const currentHead = await headSha(cwd);
    stale = !!currentHead && currentHead !== record.gitHead;
  }
  return {
    id,
    name: entry.manifest?.name ?? entry.project,
    project: entry.project,
    version: entry.manifest?.version ?? null,
    state,
    enabled: reg?.enabled === true,
    activeVersion,
    manifestSource: entry.manifestSource ?? { type: 'main' },
    hasBackend,
    hasFrontend: !!entry.manifest?.frontend,
    navLabel: entry.manifest?.frontend?.navLabel ?? null,
    frontendPath: entry.manifest?.frontend?.path ?? null,
    hasMcp: !!entry.manifest?.mcp,
    // Contribution metadata (slugs namespaced <plugin-id>/<slug>).
    // `hasScaffold` flags a convention whose pick triggers a one-time setup
    // directive (returned by create_project) in addition to any fragment.
    conventions: (entry.manifest?.conventions ?? []).map(g => ({ slug: `${id}/${g.slug}`, name: g.name, description: g.description, hasScaffold: !!g.scaffold })),
    roles: (entry.manifest?.roles ?? []).map(r => ({ slug: `${id}/${r.slug}`, name: r.name })),
    port: record?.port ?? null,
    pid: record?.pid ?? null,
    startedAt: record?.startedAt ?? null,
    gitHead: record?.gitHead ?? null,
    stale,
    errors: entry.errors ?? [],
    crashTail: runtime?.tail ?? null,
  };
}
