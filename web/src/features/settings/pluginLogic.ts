// Pure helpers behind Settings → Plugins (rows from GET /api/plugins, library
// entries from GET /api/plugins/library).

export type PluginRow = {
  id: string; name: string; project: string; state: string; enabled?: boolean; autoStart?: boolean; version?: string;
  activeVersion?: { type: 'main' } | { type: 'worktree'; name: string }; gitHead?: string; stale?: boolean; port?: number;
  manifestSource?: { type: string; name?: string }; conventions?: { name: string; description: string; hasScaffold?: boolean }[];
  roles?: unknown[]; playbooks?: unknown[]; errors?: string[]; crashTail?: string; hasBackend?: boolean;
  localOnly?: string[]; system?: string;
};
export type LibraryEntry = {
  id: string; name: string; description?: string; repo: string; installed: boolean; installedAs?: string | null; updateAvailable?: boolean;
};
export type UpdateResult = {
  project: string;
  postPull?: { ran?: boolean; ok?: boolean; tail?: string };
  restarted?: { ok?: boolean; error?: string; skipped?: boolean } | null;
};

/** The installed library entries behind their origin: what Update all would update. */
export const updatableEntries = (library: LibraryEntry[] | null): LibraryEntry[] => (library || []).filter((e) => e.installed && e.updateAvailable);

export const versionLabel = (row: PluginRow) => (row.activeVersion?.type === 'worktree' ? row.activeVersion.name : 'main');

/** The meta line under a plugin's name. */
export function metaBits(row: PluginRow): string[] {
  const bits = [`project ${row.project}`];
  if (row.version) bits.push(`v${row.version}`);
  if (row.state === 'ready') {
    bits.push(`running ${versionLabel(row)}${row.gitHead ? ` @ ${row.gitHead.slice(0, 7)}` : ''}`);
    if (row.stale) bits.push('update available');
    if (row.port) bits.push(`port ${row.port}`);
  } else if ((row.activeVersion?.type ?? 'main') === 'worktree') {
    bits.push(`version ${versionLabel(row)}`);
  }
  if (row.manifestSource?.type === 'worktree') bits.push(`manifest from worktree ${row.manifestSource.name}`);
  return bits;
}

export function contributions(row: PluginRow): string[] {
  const out: string[] = [];
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  if (row.conventions?.length) out.push(n(row.conventions.length, 'project convention'));
  if (row.roles?.length) out.push(n(row.roles.length, 'role'));
  if (row.playbooks?.length) out.push(n(row.playbooks.length, 'playbook'));
  return out;
}

export const isUsable = (row: PluginRow) => !['invalid', 'incompatible', 'conflict'].includes(row.state);
export const backendLocalOnly = (row: PluginRow) => (Array.isArray(row.localOnly) ? row.localOnly : []).includes('PLUGIN_BACKEND_LOCAL_ONLY');

/** A succeeded update can still need the user's attention: a failed hook wins over a failed restart. */
export function updateWarning(name: string, result: UpdateResult): { text: string; tail?: string } | null {
  const hookFailed = !!result.postPull?.ran && !result.postPull.ok;
  if (result.restarted?.skipped) {
    return { text: `Updated ${name}, but its post-update command failed — its backend was left running the old code`, tail: hookFailed ? result.postPull?.tail : undefined };
  }
  if (hookFailed) return { text: `Updated ${name}, but its post-update command failed`, tail: result.postPull?.tail };
  if (result.restarted && !result.restarted.ok) return { text: `Updated ${name}, but restarting its backend failed: ${result.restarted.error}` };
  return null;
}

/** An update puts new code under every plugin of each updated project. */
export function updateChange(results: UpdateResult[], rows: PluginRow[]) {
  const projects = new Set(results.map((r) => r.project));
  return { action: 'update' as const, ids: rows.filter((r) => projects.has(r.project)).map((r) => r.id) };
}

/** A failed postClone after a good clone is a warning, not an install failure. */
export function hookWarning(name: string, verb: string, hookLabel: string, hook?: { ran?: boolean; ok?: boolean; tail?: string }) {
  if (!hook?.ran || hook.ok) return null;
  return { text: `${verb} ${name}, but its ${hookLabel} command failed`, tail: hook.tail };
}
