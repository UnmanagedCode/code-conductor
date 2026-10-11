import * as React from 'react';
import { PencilIcon, PlusIcon, ServerIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { createStore, useStore } from '@/state/createStore';
import { SectionIntro, SettingsCard, Status, Field } from './ui';
import { json, post, patch, del, errText } from './api';
import { launchFromText } from './models/logic';

type System = {
  id: string; label: string; managed?: boolean; launch?: string[] | null; worktreesDir?: string | null;
  projects?: ({ name: string; remoteId?: string | null } | string)[];
};

const EMPTY = { id: '', label: '', launch: '', worktreesDir: '' };

// An unsaved Add or Edit lives at module scope, not in the component: Settings remounts a section on every switch and on re-entry, and typed input must survive both.
export const systemsDraftStore = createStore<{ editing: string | null; form: typeof EMPTY; formStatus: string | null }>({ editing: null, form: EMPTY, formStatus: null });

export function SystemsSection() {
  const [systems, setSystems] = React.useState<System[] | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const { editing, form, formStatus } = useStore(systemsDraftStore, (s) => s);
  const setForm = (patch: Partial<typeof EMPTY>) => systemsDraftStore.set((s) => ({ form: { ...s.form, ...patch } }));
  const setFormStatus = (formStatus: string | null) => systemsDraftStore.set({ formStatus });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    json<{ systems: System[] }>('/api/settings/systems')
      .then((d) => setSystems(d.systems || []))
      .catch((e) => setStatus(`Failed to load systems: ${errText(e)}`));
  }, []);

  function closeForm() {
    systemsDraftStore.set({ editing: null, form: EMPTY, formStatus: null });
  }

  function openEdit(s: System) {
    systemsDraftStore.set({
      editing: s.id,
      form: { id: s.id, label: s.label, launch: Array.isArray(s.launch) ? s.launch.join(' ') : '', worktreesDir: typeof s.worktreesDir === 'string' ? s.worktreesDir : '' },
      formStatus: null,
    });
  }

  async function save() {
    setBusy(true);
    setFormStatus(form.launch.trim() ? 'Connecting to the system…' : null);
    try {
      const body = { label: form.label.trim(), launch: launchFromText(form.launch), worktreesDir: form.worktreesDir.trim() || null };
      const out = editing
        ? await patch<{ systems: System[] }>(`/api/settings/systems/${encodeURIComponent(editing)}`, body)
        : await post<{ systems: System[] }>('/api/settings/systems', { id: form.id.trim(), ...body });
      closeForm();
      setSystems(out.systems || []);
    } catch (e) {
      setFormStatus(`Save failed: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      const out = await del<{ systems: System[] }>(`/api/settings/systems/${encodeURIComponent(id)}`);
      if (editing === id) closeForm();
      setStatus(null);
      setSystems(out.systems || []);
    } catch (e) {
      setStatus(`Remove failed: ${errText(e)}`);
    }
  }

  return (
    <div className="space-y-6">
      <SectionIntro title="Systems">
        A <strong>system</strong> is an execution environment a project's tree can live on: its git repo, its files and the commands run in it. <strong>This machine</strong> is built in and holds every project whose record names no other. A system's <strong>provider command</strong> is what cc runs to reach it; saving one connects to it first, and a system that doesn't answer is refused. A system with no command is a name only, and its projects can't be reached. One system can serve many named <strong>targets</strong> (one provider reaching a whole docker daemon, say); each project picks its target. A system a project still names can't be removed until the project moves.
      </SectionIntro>
      {systems && <Status text={`${systems.length} system${systems.length === 1 ? '' : 's'} · ${systems.filter((s) => s.managed).length} built in.`} />}
      <Status text={status} tone={status?.startsWith('Failed') || status?.startsWith('Remove') ? 'error' : 'muted'} />
      {!systems && !status && <Status text="Loading…" />}
      <div className="grid gap-3" data-testid="system-list">
        {(systems || []).map((s) => {
          const projects = Array.isArray(s.projects) ? s.projects : [];
          return (
            <div key={s.id} data-system={s.id} className="rounded-xl border bg-card px-4 py-3 shadow-xs">
              <div className="flex flex-wrap items-center gap-2">
                <ServerIcon className="size-4 text-muted-foreground" />
                <span className="font-medium">{s.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{s.id}</span>
                {s.managed && <Badge variant="secondary">built in</Badge>}
                {!s.managed && (
                  <div className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(s)} aria-label={`Edit ${s.label}`}><PencilIcon /> Edit</Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void remove(s.id)} aria-label={`Remove ${s.label}`}><Trash2Icon /> Remove</Button>
                  </div>
                )}
              </div>
              {!s.managed && (
                <div className="mt-1.5 overflow-x-auto font-mono text-xs whitespace-nowrap text-muted-foreground" data-launch>
                  {Array.isArray(s.launch) && s.launch.length ? s.launch.join(' ') : 'No provider command. This system is a name only, and its projects cannot be reached.'}
                </div>
              )}
              {!s.managed && typeof s.worktreesDir === 'string' && s.worktreesDir && (
                <div className="mt-1 font-mono text-xs text-muted-foreground">worktrees: {s.worktreesDir}</div>
              )}
              {projects.length > 0 && (
                <div className="mt-1 text-xs text-muted-foreground">
                  projects: {projects.map((x) => (typeof x === 'object' && x ? (x.remoteId ? `${x.name} (${x.remoteId})` : x.name) : String(x))).join(', ')}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <SettingsCard title={editing ? `Edit ${systems?.find((s) => s.id === editing)?.label ?? editing}` : 'Add a system'}>
        <form className="grid gap-3 @xl:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={editing ? 'Edit system' : 'Add system'}>
          <Field label="Id" htmlFor="sy-id"><Input id="sy-id" value={form.id} disabled={!!editing} onChange={(e) => setForm({ id: e.target.value })} placeholder="e.g. prod-box" autoComplete="off" /></Field>
          <Field label="Label" htmlFor="sy-label"><Input id="sy-label" value={form.label} onChange={(e) => setForm({ label: e.target.value })} placeholder="e.g. Prod box" autoComplete="off" /></Field>
          <Field label="Provider command" htmlFor="sy-launch" className="@xl:col-span-2" hint="Run directly, never through a shell. Leave empty for a name-only system.">
            <Input id="sy-launch" className="font-mono" value={form.launch} onChange={(e) => setForm({ launch: e.target.value })} placeholder="e.g. docker exec -i ctr cc-provider" autoComplete="off" />
          </Field>
          <Field label="Worktrees directory (optional)" htmlFor="sy-worktrees-dir" className="@xl:col-span-2" hint="Absolute path on the system. Default: beside each project.">
            <Input id="sy-worktrees-dir" className="font-mono" value={form.worktreesDir} onChange={(e) => setForm({ worktreesDir: e.target.value })} autoComplete="off" />
          </Field>
          <div className="flex flex-wrap justify-end gap-2 @xl:col-span-2">
            {editing && <Button type="button" variant="ghost" onClick={closeForm}>Cancel</Button>}
            <Button type="submit" disabled={busy}>{editing ? 'Save' : <><PlusIcon /> Add system</>}</Button>
          </div>
        </form>
        <Status text={formStatus} tone={formStatus?.startsWith('Save failed') ? 'error' : 'muted'} />
      </SettingsCard>
    </div>
  );
}
