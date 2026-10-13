import * as React from 'react';
import { BarChart3Icon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { createStore, useStore } from '@/state/createStore';
import { openCosts } from '@/features/views/api';
import { cn } from '@/lib/utils';
import { SectionIntro, SettingsCard, Status, Field, RangeField } from '../ui';
import { json, post, patch, del, errText } from '../api';
import { modelsSettingsStore, applyModelsPayload, savePrefs, setModelsStatus } from './store';
import {
  CLAUDE_BACKEND, backendIdFor, backendLabel, claudeVersions, defaultClaudeModel, describeBinding, firstModelForBackend,
  fmtCtxTokens, modelsForBackend, parseCtxTokens, type Binding, type ModelsPayload,
} from './logic';

// An unsaved Add or Edit lives at module scope, not in the component: Settings remounts a section on every switch and on re-entry, and typed input must survive both.
export const modelsDraftStore = createStore<{
  editing: { backend: string; model: string } | null;
  form: { label: string; backend: string; model: string; context: string; steer: boolean };
  status: { text: string; tone: 'ok' | 'error' | 'muted' } | null;
  roleName: string;
}>({ editing: null, form: { label: '', backend: '', model: '', context: '', steer: true }, status: null, roleName: '' });

// ── Row layout ───────────────────────────────────────────────────────────

// A row goes one-line once its list's container fits it; literal strings, so Tailwind sees them.
// Tiers then share a column header; roles have none, so their captions stay.
const WIDE = {
  tier: { field: '@min-[39rem]:contents', caption: '@min-[39rem]:hidden', pair: 'grid grid-cols-2 gap-2 @min-[39rem]:contents' },
  role: { field: '', caption: '', pair: 'col-span-2 grid grid-cols-2 gap-2 @min-[43rem]:contents' },
} as const;
type Wide = keyof typeof WIDE;

/** A select under its own caption, a word of the select's row-specific `aria-label`. */
function Captioned({ id, caption, wide, children }: { id: string; caption: string; wide: Wide; children: React.ReactNode }) {
  return <Field label={caption} htmlFor={id} className={WIDE[wide].field} labelClassName={WIDE[wide].caption}>{children}</Field>;
}

// ── Pickers ──────────────────────────────────────────────────────────────

/** Backend + model selects for a tier or a Custom role binding, captioned; `effort` pairs with the model. */
export function BackendPicker({ data, binding, enabled, rowLabel, idPrefix, wide, effort, onBackend, onModel }: {
  data: ModelsPayload; binding: Binding; enabled: boolean; rowLabel: string; idPrefix: string; wide: Wide; effort: React.ReactNode;
  onBackend: (backend: string) => void; onModel: (model: string) => void;
}) {
  const backendId = backendIdFor(binding);
  const backends = data.backends || [{ id: CLAUDE_BACKEND, label: 'Claude', managed: true }];
  let modelSelect: React.ReactNode;
  if (backendId !== CLAUDE_BACKEND) {
    const { curated, custom } = modelsForBackend(data, backendId);
    if (!curated.length && !custom.length) {
      modelSelect = (
        <NativeSelect id={`${idPrefix}-model`} size="sm" disabled aria-label={`Model for ${rowLabel}`} className="w-full">
          <option>(add a model under Custom models)</option>
        </NativeSelect>
      );
    } else {
      modelSelect = (
        <NativeSelect id={`${idPrefix}-model`} size="sm" disabled={!enabled} aria-label={`Model for ${rowLabel}`} className="w-full" value={binding.model} onChange={(e) => onModel(e.target.value)}>
          {curated.length > 0 && (
            <optgroup label={`${backendLabel(data, backendId)} Cloud`}>
              {curated.map((c) => <option key={c.model} value={c.model}>{c.label} — {c.model}</option>)}
            </optgroup>
          )}
          {custom.length > 0 && (
            <optgroup label="My Models">
              {custom.map((c) => <option key={c.model} value={c.model}>{c.label} — {c.model}</option>)}
            </optgroup>
          )}
        </NativeSelect>
      );
    }
  } else {
    modelSelect = (
      <NativeSelect id={`${idPrefix}-model`} size="sm" disabled={!enabled} aria-label={`Model for ${rowLabel}`} className="w-full" value={binding.model} onChange={(e) => onModel(e.target.value)}>
        {claudeVersions(data).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </NativeSelect>
    );
  }
  return (
    <>
      <Captioned id={`${idPrefix}-backend`} caption="Backend" wide={wide}>
        <NativeSelect id={`${idPrefix}-backend`} size="sm" disabled={!enabled} aria-label={`Backend for ${rowLabel}`} className="w-full" value={backendId} onChange={(e) => onBackend(e.target.value)}>
          {backends.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </NativeSelect>
      </Captioned>
      <div data-field-pair className={WIDE[wide].pair}>
        <Captioned id={`${idPrefix}-model`} caption="Model" wide={wide}>{modelSelect}</Captioned>
        {effort}
      </div>
    </>
  );
}

export function EffortPicker({ id, data, value, enabled, onPick, inheritLabel, label }: {
  id?: string; data: ModelsPayload; value: string | undefined; enabled: boolean; onPick: (v: string) => void; inheritLabel?: string; label: string;
}) {
  const efforts = data.efforts || [];
  const options = [...(inheritLabel ? ['inherit'] : []), ...efforts];
  // A level the payload doesn't list shows the server default, never the first level.
  let v = value && options.includes(value) ? value : data.defaultEffort || 'high';
  if (!options.includes(v)) v = options[0];
  return (
    <NativeSelect id={id} size="sm" disabled={!enabled} aria-label={label} className="w-full" value={v} onChange={(e) => onPick(e.target.value)}>
      {inheritLabel && <option value="inherit">{inheritLabel}</option>}
      {efforts.map((l) => <option key={l} value={l}>{l}</option>)}
    </NativeSelect>
  );
}

// ── Tier / role save paths ───────────────────────────────────────────────

const saveTierBinding = (tier: string, backend: Binding) => savePrefs({ tierBackend: { tier, backend } }, 'Switch');
const saveRoleBinding = (role: string, backend: Binding | { kind: 'tier'; tier: string }) => savePrefs({ roleBackend: { role, backend } }, 'Switch');

function switchBackend(data: ModelsPayload, backend: string, tier: string | null, save: (b: Binding) => void) {
  if (backend !== CLAUDE_BACKEND) {
    const chosen = firstModelForBackend(data, backend, tier);
    if (!chosen) {
      setModelsStatus(`Add a ${backendLabel(data, backend)} model under Custom models first.`);
      // Re-render so the select snaps back to the row's current backend.
      modelsSettingsStore.set({ data: { ...data } });
      return;
    }
    save({ backend, model: chosen.model });
    return;
  }
  save({ backend: CLAUDE_BACKEND, model: defaultClaudeModel(data) ?? '' });
}

// ── Cards ────────────────────────────────────────────────────────────────

function TiersCard({ data }: { data: ModelsPayload }) {
  const tiers = data.tiers || [];
  const enabled = data.enabledTiers ?? {};
  const defaultTier = data.defaultSpawnTier ?? 'powerful';
  const enabledCount = tiers.filter((t) => enabled[t.tier] !== false).length;
  const bindingFor = (tier: string): Binding => data.tierBackend?.[tier] || { backend: CLAUDE_BACKEND, model: '' };
  return (
    <SettingsCard
      title="Capability tiers"
      description="The new-session dialog picks a tier; it resolves to the tier's backend and model. Each tier also has a default effort a spawn on it runs at unless the spawn names its own."
    >
      <div className="@container space-y-4">
        <div className="hidden grid-cols-[2.5rem_6rem_7.5rem_minmax(0,1fr)_6.5rem_4.5rem] gap-3 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase @min-[39rem]:grid">
          <span>On</span><span>Tier</span><span>Backend</span><span>Model</span><span>Effort</span><span className="text-center">Default</span>
        </div>
        <ul className="divide-y" data-testid="tier-list">
          {[...tiers].reverse().map((t) => {
            const isEnabled = enabled[t.tier] !== false;
            const isDefault = t.tier === defaultTier;
            const isLast = isEnabled && enabledCount === 1;
            const b = bindingFor(t.tier);
            const rowLabel = `the ${t.label} tier`;
            return (
              <li
                key={t.tier}
                data-tier={t.tier}
                className={cn(
                  'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0 @min-[39rem]:grid-cols-[2.5rem_6rem_7.5rem_minmax(0,1fr)_6.5rem_4.5rem]',
                  !isEnabled && 'opacity-60',
                )}
              >
                <Switch
                  checked={isEnabled}
                  disabled={isLast}
                  aria-label={`Enable the ${t.label} tier`}
                  title={isLast ? 'At least one tier stays enabled' : undefined}
                  onCheckedChange={(on) => void savePrefs({ tierEnabled: { tier: t.tier, enabled: on } })}
                />
                <span className="truncate text-sm font-medium">{t.label}</span>
                <label className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground @min-[39rem]:order-last @min-[39rem]:justify-center">
                  <input
                    type="radio"
                    name="default-tier"
                    className="size-4 accent-primary"
                    checked={isDefault}
                    disabled={!isEnabled}
                    aria-label={`Default spawn tier: ${t.label}`}
                    onChange={() => void savePrefs({ defaultSpawnTier: t.tier })}
                  />
                  <span className="@min-[39rem]:hidden">Default</span>
                </label>
                <div className="col-span-3 grid min-w-0 gap-2 @min-[39rem]:contents">
                  <BackendPicker
                    data={data}
                    binding={b}
                    enabled={isEnabled}
                    rowLabel={rowLabel}
                    idPrefix={`models-tier-${t.tier}`}
                    wide="tier"
                    onBackend={(backend) => switchBackend(data, backend, t.tier, (nb) => void saveTierBinding(t.tier, nb))}
                    onModel={(model) => void saveTierBinding(t.tier, { backend: backendIdFor(b), model })}
                    effort={(
                      <Captioned id={`models-tier-${t.tier}-effort`} caption="Effort" wide="tier">
                        <EffortPicker
                          id={`models-tier-${t.tier}-effort`}
                          data={data}
                          value={data.tierEffort?.[t.tier]}
                          enabled={isEnabled}
                          label={`Default effort for the ${t.label} tier`}
                          onPick={(effort) => void savePrefs({ tierEffort: { tier: t.tier, effort } }, 'Effort change')}
                        />
                      </Captioned>
                    )}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="tier-summary">
        {tiers.map((t, i) => (
          <React.Fragment key={t.tier}>
            {i > 0 && ' · '}
            {t.label}: <span className="font-medium text-foreground">{describeBinding(data, bindingFor(t.tier))}</span>
            {t.tier === defaultTier && ' (default)'}
          </React.Fragment>
        ))}
      </p>
    </SettingsCard>
  );
}

function RolesCard({ data }: { data: ModelsPayload }) {
  const tiers = data.tiers || [];
  const defaultTier = data.defaultSpawnTier ?? 'powerful';
  const name = useStore(modelsDraftStore, (s) => s.roleName);
  const setName = (roleName: string) => modelsDraftStore.set({ roleName });
  const [status, setStatus] = React.useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function addRole() {
    const role = name.trim();
    if (!role) { setStatus({ text: 'Name is required.', tone: 'error' }); return; }
    setBusy(true);
    try {
      applyModelsPayload(await post<ModelsPayload>('/api/settings/models/roles', { role }));
      setName('');
      setStatus({ text: 'Added.', tone: 'ok' });
    } catch (e) {
      setStatus({ text: `Add failed: ${errText(e)}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function removeRole(role: string) {
    try {
      applyModelsPayload(await del<ModelsPayload>(`/api/settings/models/roles/${encodeURIComponent(role)}`));
    } catch (e) {
      setStatus({ text: `Remove failed: ${errText(e)}`, tone: 'error' });
    }
  }

  return (
    <SettingsCard
      title="Roles"
      description={<>A role follows a capability tier, or a <strong>Custom</strong> backend and model. The Conduct button uses the <strong>Conductor</strong> role; MCP <code>spawn_instance</code> can name any role as its <code>model</code>. A role's default effort follows its tier (<strong>Inherit</strong>) unless you pick one. Plugin roles can be rebound like any other, but belong to their plugin and disappear when it is disabled.</>}
    >
      <ul className="@container divide-y" data-testid="role-list">
        {(data.roles || []).map((r) => {
          const rb = (data.roleBackend || {})[r.role] || { kind: 'tier', tier: defaultTier };
          const isCustom = rb.kind !== 'tier';
          const isUser = !r.builtin && !r.plugin;
          const label = r.label || r.role;
          const rowLabel = `the ${label} role`;
          const re = (data.roleEffort || {})[r.role] || {};
          const effortField = (
            <Captioned id={`models-role-${r.role}-effort`} caption="Effort" wide="role">
              <EffortPicker
                id={`models-role-${r.role}-effort`}
                data={data}
                value={re.effort || 'inherit'}
                enabled
                inheritLabel={`Inherit (${re.inheritsTo || data.defaultEffort || 'high'})`}
                label={`Default effort for the ${label} role`}
                onPick={(effort) => void savePrefs({ roleEffort: { role: r.role, effort } }, 'Effort change')}
              />
            </Captioned>
          );
          return (
            <li key={r.role} data-role={r.role} className="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex w-full min-w-0 items-center gap-2 @min-[43rem]:w-36">
                <span className="truncate text-sm font-medium">{label}</span>
                {r.plugin && <Badge variant="plan" className="shrink-0">{r.plugin}</Badge>}
                {isUser && (
                  <Button variant="ghost" size="icon-sm" className="ml-auto size-7 text-muted-foreground @min-[43rem]:hidden" aria-label={`Remove role ${r.role}`} onClick={() => void removeRole(r.role)}>
                    <XIcon className="size-3.5" />
                  </Button>
                )}
              </div>
              <div className={cn('grid min-w-0 flex-1 gap-2', isCustom ? 'grid-cols-2 @min-[43rem]:grid-cols-[7rem_7rem_minmax(0,1fr)_8rem]' : 'grid-cols-2 @min-[43rem]:grid-cols-[7rem_8rem]')}>
                <Captioned id={`models-role-${r.role}-binding`} caption="Binding" wide="role">
                  <NativeSelect
                    id={`models-role-${r.role}-binding`}
                    size="sm"
                    className="w-full"
                    aria-label={`Binding for ${rowLabel}`}
                    value={isCustom ? 'custom' : `tier:${rb.tier}`}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v.startsWith('tier:')) void saveRoleBinding(r.role, { kind: 'tier', tier: v.slice(5) });
                      else void saveRoleBinding(r.role, { backend: CLAUDE_BACKEND, model: defaultClaudeModel(data) ?? '' });
                    }}
                  >
                    {tiers.map((t) => <option key={t.tier} value={`tier:${t.tier}`}>{t.label}</option>)}
                    <option value="custom">Custom</option>
                  </NativeSelect>
                </Captioned>
                {isCustom ? (
                  <BackendPicker
                    data={data}
                    binding={rb as Binding}
                    enabled
                    rowLabel={rowLabel}
                    idPrefix={`models-role-${r.role}`}
                    wide="role"
                    onBackend={(backend) => switchBackend(data, backend, null, (nb) => void saveRoleBinding(r.role, nb))}
                    onModel={(model) => void saveRoleBinding(r.role, { backend: backendIdFor(rb as Binding), model })}
                    effort={effortField}
                  />
                ) : effortField}
              </div>
              {isUser && (
                <Button variant="ghost" size="icon-sm" className="hidden size-7 text-muted-foreground @min-[43rem]:inline-flex" aria-label={`Remove role ${r.role}`} title={`Remove role ${r.role}`} onClick={() => void removeRole(r.role)}>
                  <XIcon className="size-3.5" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void addRole(); }}>
        <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Role name (e.g. tester)" autoComplete="off" className="max-w-64 flex-1" aria-label="New role name" />
        <Button type="submit" variant="outline" disabled={busy}><PlusIcon /> Add role</Button>
      </form>
      <p className="text-xs text-muted-foreground">New roles start on the Powerful tier. Rebind them with their picker.</p>
      <Status text={status?.text} tone={status?.tone} />
    </SettingsCard>
  );
}

type CustomModel = NonNullable<ModelsPayload['customModels']>[number];

function CustomModelsCard({ data }: { data: ModelsPayload }) {
  const list = data.customModels || [];
  const substitution = (data.backends || []).filter((b) => b.id !== CLAUDE_BACKEND);
  const { editing, form, status } = useStore(modelsDraftStore, (s) => s);
  const [busy, setBusy] = React.useState(false);

  const backend = substitution.some((b) => b.id === form.backend) ? form.backend : substitution[0]?.id ?? '';

  // An edited pair that left the payload (removed elsewhere) ends edit mode.
  React.useEffect(() => {
    if (editing && !list.some((c) => c.backend === editing.backend && c.model === editing.model)) closeForm();
  }, [list, editing]);

  const setForm = (patch: Partial<typeof form>) => modelsDraftStore.set((s) => ({ form: { ...s.form, ...patch } }));
  const setStatus = (status: { text: string; tone: 'ok' | 'error' | 'muted' } | null) => modelsDraftStore.set({ status });

  function closeForm() {
    modelsDraftStore.set((s) => ({ editing: null, form: { label: '', backend: s.form.backend, model: '', context: '', steer: true }, status: null }));
  }

  function openEdit(c: CustomModel) {
    modelsDraftStore.set({
      editing: { backend: c.backend, model: c.model },
      form: { label: c.label, backend: c.backend, model: c.model, context: String(c.contextWindow), steer: c.midTurnSteering !== false },
      status: { text: `Editing ${c.label}. Backend and model id are fixed.`, tone: 'muted' },
    });
  }

  async function save() {
    const label = form.label.trim();
    const model = form.model.trim();
    if (!label || !model || !backend) { setStatus({ text: 'Label, backend, and model id are required.', tone: 'error' }); return; }
    const ctx = parseCtxTokens(form.context);
    if (ctx === null) { setStatus({ text: 'Context is required: a positive token count, optionally with a k or m suffix (e.g. 200k, 1m).', tone: 'error' }); return; }
    setBusy(true);
    setStatus({ text: editing ? 'Saving…' : 'Adding…', tone: 'muted' });
    try {
      const out = editing
        ? await patch<ModelsPayload>(`/api/settings/models/custom/${encodeURIComponent(editing.backend)}/${encodeURIComponent(editing.model)}`, { label, contextWindow: ctx, midTurnSteering: form.steer })
        : await post<ModelsPayload>('/api/settings/models/custom', { label, model, backend, contextWindow: ctx, midTurnSteering: form.steer });
      const wasEditing = !!editing;
      modelsDraftStore.set((s) => ({ editing: null, form: { label: '', backend: s.form.backend, model: '', context: '', steer: true } }));
      setStatus({ text: wasEditing ? 'Saved.' : 'Added.', tone: 'ok' });
      applyModelsPayload(out);
    } catch (e) {
      setStatus({ text: `${editing ? 'Save' : 'Add'} failed: ${errText(e)}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: CustomModel) {
    try {
      applyModelsPayload(await del<ModelsPayload>(`/api/settings/models/custom/${encodeURIComponent(c.backend)}/${encodeURIComponent(c.model)}`));
    } catch (e) {
      setStatus({ text: `Remove failed: ${errText(e)}`, tone: 'error' });
    }
  }

  return (
    <SettingsCard
      title="Custom models"
      description={<>A model served by one of your <strong>Backends</strong>. Bind it by picking that backend for a tier or role above. <strong>Context</strong> is the model's native window (<code>200000</code>, <code>200k</code> or <code>1m</code>); it drives the context bar and the CLI's auto-compact point, so a wrong value truncates or over-fills the window. Untick <strong>Accepts mid-turn steering</strong> if the model errors on, or ignores, a message sent into a running turn; such a send then stops the turn at a block boundary and arrives as a fresh turn. To change a model's backend or id, remove it and add it again.</>}
    >
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No custom models yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="custom-list">
          {list.map((c) => (
            <li key={`${c.backend}/${c.model}`} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', editing?.backend === c.backend && editing.model === c.model && 'bg-accent/50')}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.label}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {c.model} · {backendLabel(data, c.backend)}{Number.isFinite(c.contextWindow) && ` · ${fmtCtxTokens(c.contextWindow)} ctx`}{c.midTurnSteering === false && ' · no mid-turn steering'}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => openEdit(c)} aria-label={`Edit ${c.label}`}><PencilIcon /> Edit</Button>
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void remove(c)} aria-label={`Remove ${c.label}`}><Trash2Icon /> Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-3 rounded-lg border border-dashed p-3 @lg:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={editing ? 'Edit custom model' : 'Add custom model'}>
        <Field label="Label" htmlFor="cm-label"><Input id="cm-label" value={form.label} onChange={(e) => setForm({ label: e.target.value })} placeholder="e.g. Local GPT" autoComplete="off" /></Field>
        <Field label="Backend" htmlFor="cm-backend">
          <NativeSelect id="cm-backend" className="w-full" value={backend} disabled={!substitution.length || !!editing} onChange={(e) => setForm({ backend: e.target.value })}>
            {substitution.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Model id" htmlFor="cm-model"><Input id="cm-model" value={form.model} disabled={!!editing} onChange={(e) => setForm({ model: e.target.value })} placeholder="e.g. gemma4:cloud" autoComplete="off" /></Field>
        <Field label="Context" htmlFor="cm-context"><Input id="cm-context" value={form.context} onChange={(e) => setForm({ context: e.target.value })} placeholder="e.g. 200k or 1m" autoComplete="off" /></Field>
        <div className="flex flex-wrap items-center gap-3 @lg:col-span-2">
          <Label className="font-normal"><Checkbox id="cm-steer" checked={form.steer} onCheckedChange={(v) => setForm({ steer: !!v })} /> Accepts mid-turn steering</Label>
          <div className="ml-auto flex gap-2">
            {editing && <Button type="button" variant="ghost" onClick={closeForm}>Cancel</Button>}
            <Button type="submit" disabled={busy}>{editing ? 'Save' : <><PlusIcon /> Add model</>}</Button>
          </div>
        </div>
      </form>
      <Status text={status?.text} tone={status?.tone} />
    </SettingsCard>
  );
}

function ConductorSessionCard({ data }: { data: ModelsPayload }) {
  const cw = data.conductorCompactWindow ?? { enabled: false, value: 200 };
  const [value, setValue] = React.useState(cw.value);
  React.useEffect(() => setValue(cw.value), [cw.value]);
  const save = (enabled: boolean, v: number) => void savePrefs({ conductorCompactWindow: { enabled, value: v } }, 'Update', false);
  return (
    <SettingsCard
      title="Conductor session"
      description="The context size at which the Conduct orchestrator session auto-compacts. Workers it spawns are not affected. Off by default."
      action={<Switch checked={cw.enabled} aria-label="Override the compact window for the Conduct session" onCheckedChange={(on) => save(on, value)} />}
    >
      {cw.enabled && (
        <RangeField id="compact-window" label="Window" min={100} max={1000} step={10} value={value} format={(v) => `${v}k`} onInput={setValue} onCommit={(v) => save(true, v)} />
      )}
    </SettingsCard>
  );
}

function DebugDefaultCard() {
  const [on, setOn] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    json<{ debugByDefault: boolean }>('/api/settings/spawn').then((d) => setOn(!!d.debugByDefault)).catch(() => setOn(false));
  }, []);
  return (
    <SettingsCard
      title="Debug capture"
      description="Mirror raw CLI traffic of new sessions to the debug directory unless a spawn sets debug itself (the new-session dialog's Advanced options always win). Off by default."
      action={
        <Switch
          checked={!!on}
          disabled={on === null}
          aria-label="Enable debug capture by default for new sessions"
          onCheckedChange={(v) => {
            setOn(v);
            post('/api/settings/spawn/prefs', { debugByDefault: v }).catch(() => { /* next open re-syncs */ });
          }}
        />
      }
    />
  );
}

export function ModelsSection() {
  const { data, error, status } = useStore(modelsSettingsStore, (s) => s);
  return (
    <div className="@container space-y-6">
      <SectionIntro title="Models">
        Each capability tier binds to a backend (managed under <strong>Backends</strong>) and a model on it: a Claude version, or one of your custom models. Every model has one native context window, so there is no window to pick. Changes apply to new spawns immediately, with no restart.
      </SectionIntro>
      <Status text={error ?? status} tone="error" />
      {!data ? !error && <Status text="Loading…" /> : (
        <>
          <TiersCard data={data} />
          <RolesCard data={data} />
          <CustomModelsCard data={data} />
          <div className="grid gap-6 @2xl:grid-cols-2">
            <ConductorSessionCard data={data} />
            <DebugDefaultCard />
          </div>
          <Button variant="outline" onClick={openCosts}><BarChart3Icon /> Cost dashboard</Button>
        </>
      )}
    </div>
  );
}
