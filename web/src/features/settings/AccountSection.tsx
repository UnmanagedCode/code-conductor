import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { createStore, useStore } from '@/state/createStore';
import { accountChanged } from '@/app/accountUsage';
import { cn } from '@/lib/utils';
import { SectionIntro, SettingsCard, Status, RangeField } from './ui';
import { post, errText } from './api';
import { modelsSettingsStore, applyModelsPayload } from './models/store';
import type { ModelsPayload } from './models/logic';
import { ClaudeLogin } from './ClaudeLogin';

type Overage = 'none' | 'stop' | 'stop-resume';
type Staged = { action: Overage; thEnabled: boolean; thValue: number };
const OPTIONS: [Overage, string][] = [['none', 'Off'], ['stop', 'Stop'], ['stop-resume', 'Stop & resume']];

// An unapplied overage edit and its status line live at module scope, not in the component: Settings remounts a section on every switch, and both must survive it.
export const overageDraftStore = createStore<{ staged: Staged | null; status: { text: string; ok: boolean } | null }>({ staged: null, status: null });

/** Opening Settings drops an unapplied overage edit and its status line, so the controls show the payload it reloads. */
export function discardOverageDraft() {
  overageDraftStore.set({ staged: null, status: null });
}

const committed = (data: ModelsPayload | null): Staged => {
  const ot = data?.overageThreshold ?? { enabled: false, value: 85 };
  return { action: data?.onOverage ?? 'none', thEnabled: ot.enabled, thValue: ot.value };
};

/**
 * Overage protection is staged: edits stay in the draft until Apply, and a models
 * payload arriving from elsewhere (a tier toggle) never clobbers an unapplied edit.
 */
export function OverageCard() {
  const data = useStore(modelsSettingsStore, (s) => s.data);
  const { staged, status } = useStore(overageDraftStore, (s) => s);
  const dirty = staged !== null;
  const { action, thEnabled, thValue } = staged ?? committed(data);

  const edit = (patch: Partial<Staged>) =>
    overageDraftStore.set((s) => ({ staged: { ...(s.staged ?? committed(modelsSettingsStore.get().data)), ...patch }, status: null }));

  async function apply() {
    try {
      const out = await post<ModelsPayload>('/api/settings/models/prefs', { onOverage: action, overageThreshold: { enabled: thEnabled, value: thValue } });
      applyModelsPayload(out, false);
      overageDraftStore.set({ staged: null, status: { text: 'Overage settings applied', ok: true } });
    } catch (e) {
      overageDraftStore.set({ status: { text: `Update failed: ${errText(e)}`, ok: false } });
    }
  }

  return (
    <SettingsCard
      title="Overage protection"
      description="What happens the moment a session starts using paid overage credits. Stop soft-interrupts the turn; the session stays idle and can be resumed by hand. Stop & resume also resumes it a few seconds after the rate-limit window resets. Off by default."
    >
      <div className="flex w-fit max-w-full flex-wrap items-center rounded-lg bg-muted p-0.5 text-sm" role="group" aria-label="Action on overage">
        {OPTIONS.map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={action === v}
            onClick={() => edit({ action: v })}
            className={cn('min-h-8 rounded-md px-3 font-medium transition-colors', action === v ? 'bg-background text-foreground shadow-xs dark:bg-input/40' : 'text-muted-foreground hover:text-foreground')}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        <Label className="font-normal">
          <Switch checked={thEnabled} onCheckedChange={(v) => edit({ thEnabled: v })} aria-label="Also stop at a usage threshold" />
          Also stop at a usage threshold (any rate-limit window)
        </Label>
        <p className="max-w-[70ch] text-xs leading-relaxed text-muted-foreground">
          The chosen action also fires once utilization crosses this percentage, before paid overage begins. It is checked against the live rate-limit stream and a periodic poll of the 5-hour window, so low thresholds trip too. No effect while the action is Off.
        </p>
        {thEnabled && (
          <RangeField id="overage-threshold" label="Stop at" min={10} max={99} step={1} value={thValue} format={(v) => `${v}%`} onInput={(v) => edit({ thValue: v })} />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
        {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
        {status && <Status text={status.text} tone={status.ok ? 'ok' : 'error'} />}
        <Button onClick={() => void apply()} disabled={!dirty}>Apply</Button>
      </div>
    </SettingsCard>
  );
}

export function AccountSection() {
  return (
    <div className="space-y-6">
      <SectionIntro title="Account">
        The Anthropic account cc's <code>claude</code> CLI is signed in to, and how to protect it from paid overage. Overage settings are staged and saved together with <strong>Apply</strong>.
      </SectionIntro>
      <ClaudeLogin onLoginSuccess={() => void accountChanged()} />
      <OverageCard />
    </div>
  );
}
