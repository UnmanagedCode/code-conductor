import * as React from 'react';
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createStore, useStore } from '@/state/createStore';
import { SectionIntro, SettingsCard, Status, Field } from './ui';
import { post, patch, del, errText } from './api';
import { modelsSettingsStore, applyModelsPayload } from './models/store';
import { envFromText, envToText, type ModelsPayload } from './models/logic';

type Backend = NonNullable<ModelsPayload['backends']>[number];

const EMPTY = { id: '', label: '', template: '', env: '' };

// An unsaved Add or Edit lives at module scope, not in the component: Settings remounts a section on every switch and on re-entry, and typed input must survive both.
export const backendsDraftStore = createStore<{ editing: string | null; form: typeof EMPTY; formStatus: string | null }>({ editing: null, form: EMPTY, formStatus: null });

export function BackendsSection() {
  const { data, error } = useStore(modelsSettingsStore, (s) => s);
  const { editing, form, formStatus } = useStore(backendsDraftStore, (s) => s);
  const setForm = (patch: Partial<typeof EMPTY>) => backendsDraftStore.set((s) => ({ form: { ...s.form, ...patch } }));
  const setFormStatus = (formStatus: string | null) => backendsDraftStore.set({ formStatus });
  const [listStatus, setListStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const backends = data?.backends || [];
  const custom = data?.customModels || [];

  function closeForm() {
    backendsDraftStore.set({ editing: null, form: EMPTY, formStatus: null });
  }

  function openEdit(b: Backend) {
    backendsDraftStore.set({ editing: b.id, form: { id: b.id, label: b.label, template: b.template || '', env: envToText(b.env) }, formStatus: null });
  }

  async function save() {
    setBusy(true);
    const env = envFromText(form.env);
    try {
      const out = editing
        ? await patch<ModelsPayload>(`/api/settings/models/backends/${encodeURIComponent(editing)}`, { label: form.label.trim(), template: form.template, env })
        : await post<ModelsPayload>('/api/settings/models/backends', { id: form.id.trim(), label: form.label.trim(), template: form.template, env });
      closeForm();
      applyModelsPayload(out);
    } catch (e) {
      setFormStatus(`Save failed: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      const out = await del<ModelsPayload>(`/api/settings/models/backends/${encodeURIComponent(id)}`);
      if (editing === id) closeForm();
      setListStatus(null);
      applyModelsPayload(out);
    } catch (e) {
      setListStatus(`Remove failed: ${errText(e)}`);
    }
  }

  return (
    <div className="space-y-6">
      <SectionIntro title="Backends">
        A <strong>backend</strong> is a launch recipe: the command that replaces <code>claude</code>, with <code>{'{model}'}</code> standing in for the model id. An empty template runs <code>claude</code> directly. <strong>Claude</strong> and <strong>Ollama</strong> are built in and can't be changed or removed. Add your own for any wrapper that ends by running the Claude CLI, then add models for it under <strong>Models → Custom models</strong>. A backend can also set <strong>env</strong> variables at spawn. Changes apply to the next spawn.
      </SectionIntro>
      <Status text={error} tone="error" />
      {data && (
        <Status text={`${backends.length} backend${backends.length === 1 ? '' : 's'} · ${backends.filter((b) => b.managed).length} built in.`} />
      )}
      <Status text={listStatus} tone="error" />
      <div className="grid gap-3" data-testid="backend-list">
        {backends.map((b) => {
          const bound = custom.filter((m) => m.backend === b.id);
          return (
            <div key={b.id} data-backend={b.id} className="rounded-xl border bg-card px-4 py-3 shadow-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{b.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{b.id}</span>
                {b.managed && <Badge variant="secondary">built in</Badge>}
                {!b.managed && (
                  <div className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(b)} aria-label={`Edit ${b.label}`}><PencilIcon /> Edit</Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void remove(b.id)} aria-label={`Remove ${b.label}`}><Trash2Icon /> Remove</Button>
                  </div>
                )}
              </div>
              <div className="mt-1.5 overflow-x-auto font-mono text-xs whitespace-nowrap text-muted-foreground">{b.template || 'claude'}</div>
              {Array.isArray(b.env) && b.env.length > 0 && (
                <div className="mt-1 font-mono text-xs break-all text-muted-foreground">{b.env.map((e) => `${e.key}=${e.value}`).join('  ')}</div>
              )}
              {bound.length > 0 && <div className="mt-1 text-xs text-muted-foreground">models: {bound.map((m) => m.model).join(', ')}</div>}
            </div>
          );
        })}
      </div>
      <SettingsCard title={editing ? `Edit ${backends.find((b) => b.id === editing)?.label ?? editing}` : 'Add a backend'}>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={editing ? 'Edit backend' : 'Add backend'}>
          <Field label="Id" htmlFor="sb-id"><Input id="sb-id" value={form.id} disabled={!!editing} onChange={(e) => setForm({ id: e.target.value })} placeholder="e.g. my-proxy" autoComplete="off" /></Field>
          <Field label="Label" htmlFor="sb-label"><Input id="sb-label" value={form.label} onChange={(e) => setForm({ label: e.target.value })} placeholder="e.g. My Proxy" autoComplete="off" /></Field>
          <Field label="Template" htmlFor="sb-template" className="sm:col-span-2">
            <Input id="sb-template" className="font-mono" value={form.template} onChange={(e) => setForm({ template: e.target.value })} placeholder="e.g. myproxy run claude --model {model} --" autoComplete="off" />
          </Field>
          <Field label="Env (optional)" htmlFor="sb-env" hint="One KEY=VALUE per line." className="sm:col-span-2">
            <Textarea id="sb-env" className="font-mono" rows={3} value={form.env} onChange={(e) => setForm({ env: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            {editing && <Button type="button" variant="ghost" onClick={closeForm}>Cancel</Button>}
            <Button type="submit" disabled={busy}>{editing ? 'Save' : <><PlusIcon /> Add backend</>}</Button>
          </div>
        </form>
        <Status text={formStatus} tone="error" />
      </SettingsCard>
    </div>
  );
}
