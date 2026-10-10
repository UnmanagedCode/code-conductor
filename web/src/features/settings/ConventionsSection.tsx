import * as React from 'react';
import { ChevronRightIcon, LockIcon, PencilIcon, PlusIcon, PlugIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { NativeSelect } from '@/components/ui/native-select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useSignal } from '@/state/createStore';
import { confirmDialog } from '@/ui/feedback';
import { SectionIntro, Status, Field } from './ui';
import { json, post, put, del, errText } from './api';
import { pluginsChangedSignal } from './pluginsSignal';

export type Convention = { slug: string; name: string; description: string; body?: string; builtin?: boolean; plugin?: string };
export type ConventionsPayload = {
  core?: { name: string; description: string };
  conventions?: Convention[];
  enabled?: string[];
  // Conductor scope only:
  playbooks?: { id: string; name: string; plugin?: string }[];
  playbookErrors?: { id: string; message: string }[];
  defaultPlaybook?: { mode: 'unset' | 'none' | 'playbook'; id?: string };
  defaultPlaybookMissing?: { id: string; reason: string } | null;
  defaultPlaybookFallback?: string;
  defaultPlaybookEnforcement?: string;
  playbookEnforcementModes?: string[];
};

const CONDUCTOR_BASE = '/api/settings/conventions/conductor';

// ── Preferred playbook + enforcement (conductor scope) ───────────────────

/** The preferred-playbook options, from the payload: Unset, None, each loaded playbook, and a stored-but-missing one (disabled). */
export function playbookOptions(data: ConventionsPayload) {
  const opts: { value: string; label: string; disabled?: boolean }[] = [
    { value: 'unset', label: `Unset — falls back to ${data.defaultPlaybookFallback}` },
    { value: 'none', label: 'None — no playbook convention injected' },
    ...(data.playbooks || []).map((pb) => ({ value: `playbook:${pb.id}`, label: `${pb.id} — ${pb.name}${pb.plugin ? ` (plugin ${pb.plugin})` : ''}` })),
  ];
  const missing = data.defaultPlaybookMissing;
  if (missing) opts.push({ value: `playbook:${missing.id}`, label: `${missing.id} — not loaded`, disabled: true });
  const sel = data.defaultPlaybook || { mode: 'unset' };
  const value = sel.mode === 'playbook' ? `playbook:${sel.id}` : sel.mode;
  const notes = [
    ...(missing ? [missing.reason] : []),
    ...((data.playbookErrors || []).length
      ? [`${data.playbookErrors!.length} playbook definition(s) rejected at load: ${data.playbookErrors!.map((e) => `${e.id}: ${e.message}`).join('; ')}`]
      : []),
  ].join(' ');
  return { opts, value, notes };
}

export const ENFORCEMENT_LABELS: Record<string, string> = {
  enforce: 'Enforce — off-graph calls are refused',
  warn: 'Warn — off-graph calls are ledgered and proceed',
};

function ConductorPlaybookPrefs({ data }: { data: ConventionsPayload }) {
  const pb = playbookOptions(data);
  const [pbValue, setPbValue] = React.useState(pb.value);
  const [pbErr, setPbErr] = React.useState<string | null>(null);
  const [enf, setEnf] = React.useState(data.defaultPlaybookEnforcement ?? '');
  const [enfErr, setEnfErr] = React.useState<string | null>(null);
  React.useEffect(() => setPbValue(pb.value), [pb.value]);
  React.useEffect(() => setEnf(data.defaultPlaybookEnforcement ?? ''), [data.defaultPlaybookEnforcement]);

  async function savePlaybook(v: string) {
    setPbValue(v);
    const defaultPlaybook = v.startsWith('playbook:') ? { mode: 'playbook', id: v.slice('playbook:'.length) } : { mode: v };
    try {
      await put(`${CONDUCTOR_BASE}/default-playbook`, { defaultPlaybook });
      setPbErr(null);
    } catch (e) {
      setPbErr(`Save failed: ${errText(e)}`);
    }
  }
  async function saveEnforcement(mode: string) {
    setEnf(mode);
    try {
      await put(`${CONDUCTOR_BASE}/default-playbook-enforcement`, { mode });
      setEnfErr(null);
    } catch (e) {
      setEnfErr(`Save failed: ${errText(e)}`);
    }
  }
  return (
    <div className="grid gap-4 rounded-lg bg-muted/40 p-3 lg:grid-cols-2">
      <Field
        label="Preferred playbook"
        htmlFor="dp-select"
        hint={<>Its stages, intent and transitions are written into the conductor's prompt, so it knows its baseline graph without a tool call (<code>describe_playbook</code> stays the live authority). <em>Unset</em> uses the built-in named in that row; <em>None</em> injects nothing.</>}
      >
        <NativeSelect id="dp-select" className="w-full" value={pbValue} onChange={(e) => void savePlaybook(e.target.value)}>
          {pb.opts.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        </NativeSelect>
        <Status text={pbErr ?? pb.notes} tone={pbErr || pb.notes ? 'error' : 'muted'} />
      </Field>
      <Field
        label="Playbook enforcement"
        htmlFor="dpe-select"
        hint="The level new conductors start at. Enforce refuses an off-graph call; Warn records it and lets it through. A session's menu can override this for that session."
      >
        <NativeSelect id="dpe-select" className="w-full" value={enf} onChange={(e) => void saveEnforcement(e.target.value)}>
          {(data.playbookEnforcementModes || []).map((m) => <option key={m} value={m}>{ENFORCEMENT_LABELS[m] || m}</option>)}
        </NativeSelect>
        <Status text={enfErr} tone="error" />
      </Field>
    </div>
  );
}

// ── One scope's list ─────────────────────────────────────────────────────

type Form = { slug: string; name: string; description: string; body: string };
const EMPTY: Form = { slug: '', name: '', description: '', body: '' };

export function ConventionsPanel({ base, hasToggle, hasCoreRow, noun, bodyPlaceholder, renderExtras }: {
  base: string; hasToggle: boolean; hasCoreRow: boolean; noun: string; bodyPlaceholder: string;
  renderExtras?: (data: ConventionsPayload) => React.ReactNode;
}) {
  const pluginsVersion = useSignal(pluginsChangedSignal);
  const [data, setData] = React.useState<ConventionsPayload | null>(null);
  const [status, setStatus] = React.useState<string | null>('Loading…');
  const [enabled, setEnabled] = React.useState<Set<string>>(new Set());
  const [form, setForm] = React.useState<Form | null>(null);
  const [editingSlug, setEditingSlug] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const d = await json<ConventionsPayload>(base);
      setData(d);
      setEnabled(new Set(d.enabled || []));
      setStatus(null);
    } catch (e) {
      setStatus(`Failed: ${errText(e)}`);
    }
  }, [base]);

  // A plugin action can add or drop plugin-contributed conventions.
  React.useEffect(() => { void load(); }, [load, pluginsVersion]);

  async function toggle(slug: string, on: boolean) {
    const next = new Set(enabled);
    if (on) next.add(slug); else next.delete(slug);
    setEnabled(next);
    try {
      await put(`${base}/selection`, { enabled: [...next] });
    } catch (e) {
      setStatus(`Save failed: ${errText(e)}`);
      void load();
    }
  }

  async function save() {
    if (!form) return;
    setFormError(null);
    try {
      if (editingSlug) await put(`${base}/${encodeURIComponent(editingSlug)}`, { name: form.name.trim(), description: form.description.trim(), body: form.body });
      else await post(base, { slug: form.slug.trim(), name: form.name.trim(), description: form.description.trim(), body: form.body });
      setForm(null);
      setEditingSlug(null);
      void load();
    } catch (e) {
      setFormError(errText(e));
    }
  }

  async function remove(slug: string) {
    if (!(await confirmDialog({ title: `Delete ${noun} “${slug}”?`, confirmLabel: 'Delete', destructive: true }))) return;
    try {
      await del(`${base}/${encodeURIComponent(slug)}`);
      void load();
    } catch (e) {
      setStatus(`Delete failed: ${errText(e)}`);
    }
  }

  return (
    <div className="space-y-3">
      {data && renderExtras?.(data)}
      <Status text={status} tone={status && status !== 'Loading…' ? 'error' : 'muted'} />
      {data && (
        <ul className="divide-y rounded-lg border" data-testid={`conventions-${base.split('/').pop()}`}>
          {hasCoreRow && data.core && (
            <li className="flex items-start gap-3 px-3 py-2.5">
              <LockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{data.core.name}</span><Badge variant="secondary">always on</Badge></div>
                <div className="text-xs text-muted-foreground">{data.core.description}</div>
              </div>
            </li>
          )}
          {(data.conventions || []).map((c) => (
            <li key={c.slug} data-slug={c.slug} className="flex items-start gap-3 px-3 py-2.5">
              {hasToggle && (
                <Switch className="mt-0.5" checked={enabled.has(c.slug)} aria-label={`Enable ${c.name}`} onCheckedChange={(v) => void toggle(c.slug, v)} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{c.slug}</span>
                  {c.plugin ? <Badge variant="plan"><PlugIcon />plugin: {c.plugin}</Badge> : c.builtin ? <Badge variant="outline">built-in</Badge> : null}
                </div>
                <div className="text-xs text-muted-foreground">{c.description}</div>
              </div>
              {!c.plugin && !c.builtin && (
                <div className="flex shrink-0 gap-0.5">
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => { setEditingSlug(c.slug); setForm({ slug: c.slug, name: c.name, description: c.description, body: c.body || '' }); setFormError(null); }}>
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" aria-label={`Delete ${c.name}`} onClick={() => void remove(c.slug)}>
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {form ? (
        <form className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={editingSlug ? `Edit ${noun}` : `Add ${noun}`}>
          <Field label="Slug" htmlFor={`${base}-slug`}><Input id={`${base}-slug`} value={form.slug} disabled={!!editingSlug} placeholder="e.g. my-convention" onChange={(e) => setForm({ ...form, slug: e.target.value })} autoFocus={!editingSlug} /></Field>
          <Field label="Name" htmlFor={`${base}-name`}><Input id={`${base}-name`} value={form.name} placeholder="Short name" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus={!!editingSlug} /></Field>
          <Field label="Description" htmlFor={`${base}-desc`} className="sm:col-span-2"><Input id={`${base}-desc`} value={form.description} placeholder="One-line description" onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Body (Markdown)" htmlFor={`${base}-body`} className="sm:col-span-2">
            <Textarea id={`${base}-body`} className="min-h-32 font-mono text-[13px]" value={form.body} placeholder={bodyPlaceholder} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </Field>
          <Status text={formError} tone="error" className="sm:col-span-2" />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => { setForm(null); setEditingSlug(null); setFormError(null); }}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" size="sm" onClick={() => { setEditingSlug(null); setForm(EMPTY); setFormError(null); }}><PlusIcon /> Add custom convention</Button>
      )}
    </div>
  );
}

function Block({ title, description, children, defaultOpen }: { title: string; description: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-xl border bg-card shadow-xs">
      <CollapsibleTrigger className="group/cb flex w-full items-center gap-2 px-5 py-4 text-left">
        <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/cb:rotate-90" />
        <span className="font-semibold">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t px-5 py-4">
        <p className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]">{description}</p>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ConventionsSection() {
  return (
    <div className="space-y-6">
      <SectionIntro title="Conventions">
        Markdown guidance composed into Claude sessions at three scopes. <strong>Workspace</strong> and <strong>Conductor</strong> each have an always-on core plus built-in conventions you switch on or off; <strong>Project</strong> conventions are picked per project when it is created. Built-in bodies are read-only; every scope takes custom conventions you can add, edit and delete.
      </SectionIntro>
      <Block title="Workspace conventions" defaultOpen description={<>Composed into every project's own <code>CONVENTIONS.md</code> (above the project's own conventions) and into the conductor's role doc. A change regenerates all of those files immediately.</>}>
        <ConventionsPanel base="/api/settings/conventions/workspace" hasToggle hasCoreRow noun="workspace convention" bodyPlaceholder="Markdown composed into every project's CONVENTIONS.md" />
      </Block>
      <Block title="Conductor conventions" description={<>Composed into the Conduct orchestrator's role doc (<code>.conduct/CONVENTIONS.md</code>) for every conductor, from its next spawn or context refresh. Keep the set lean: every convention costs tokens in every conductor session.</>}>
        <ConventionsPanel
          base={CONDUCTOR_BASE}
          hasToggle
          hasCoreRow
          noun="conductor convention"
          bodyPlaceholder="Markdown composed into the conductor role prompt"
          renderExtras={(d) => <ConductorPlaybookPrefs data={d} />}
        />
      </Block>
      <Block title="Project conventions" description={<>Named sections picked per project at creation, composed into that project's <code>CONVENTIONS.md</code> and regenerated there.</>}>
        <ConventionsPanel base="/api/settings/conventions/project" hasToggle={false} hasCoreRow={false} noun="project convention" bodyPlaceholder="Markdown composed into a project's CONVENTIONS.md" />
      </Block>
    </div>
  );
}
