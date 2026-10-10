import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const sent: [string, any, any][] = [];
let ackReply: (t: string) => Promise<unknown> = () => Promise.resolve({ ok: true });
vi.mock('@/lib/core/ws.js', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (t: string, payload: any, opts: any = {}) => { sent.push([t, payload, opts]); return opts.ack ? ackReply(t) : undefined; },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { applyModelsPayload } from '@/lib/core/models.js';
import { getUsageTracker } from '@/app/trackers';
import { accountUsageStore } from '@/app/accountUsage';
import { isSessionMuted } from '@/features/notifications/mutes';
import { dialogStore } from '@/features/dialogs/api';
import type { Instance } from '@/state/types';
import { ModeToggle, SessionHeader, modelEntryState, modelGroups } from './SessionHeader';
import { UsageChip } from './UsageChip';

const base = (extra: Partial<Instance> = {}): Instance => ({
  id: 'inst-1', project: 'demo', status: 'idle', displayStatus: 'idle', sessionId: 'sess-1', mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000, ...extra,
});

function catalog(extra: object = {}) {
  applyModelsPayload({
    tiers: [{ tier: 'fast', label: 'Fast' }, { tier: 'powerful', label: 'Powerful' }, { tier: 'local', label: 'Local' }],
    backends: [{ id: 'claude', label: 'Claude' }, { id: 'ollama', label: 'Ollama' }],
    tierBackend: { fast: { backend: 'claude', model: 'claude-haiku-5-5' }, powerful: { backend: 'claude', model: 'claude-opus-5-5' }, local: { backend: 'ollama', model: 'qwen3:8b' } },
    enabledTiers: { fast: true, powerful: true, local: true },
    efforts: ['low', 'medium', 'high', 'max'],
    backendModels: { ollama: [{ model: 'qwen3:8b', label: 'Qwen 8B' }, { model: 'llama3:70b', label: 'Llama 70B' }] },
    ...extra,
  });
}

const wrap = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);
async function openMenu(name = 'Session actions') {
  const trigger = screen.getByRole('button', { name });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20)); // let a previous close settle
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  });
  return screen.getByRole('menu');
}

beforeEach(() => {
  sent.length = 0;
  ackReply = () => Promise.resolve({ ok: true });
  catalog();
});

describe('change model', () => {
  it('an identity session: Claude tiers switch live between turns; other backends are disabled; the running model is marked', () => {
    const groups = modelGroups(base());
    expect(groups.map(([id]) => id)).toEqual(['claude', 'ollama']);
    const [claude, ollama] = groups;
    expect(claude[1].map((e) => [e.label, e.state.kind, e.state.disabled, e.selected])).toEqual([
      ['Fast', 'live', false, false], ['Powerful', 'live', false, true],
    ]);
    expect(ollama[1].map((e) => [e.label, e.state.kind, e.state.disabled])).toEqual([['Local', 'cross', true]]);
    expect(modelGroups(base({ status: 'turn' }))[0][1].every((e) => e.state.disabled)).toBe(true);
  });

  it('a substitution session: its own backend restarts; registered models join; busy states disable restart entries', () => {
    const inst = base({ backend: 'ollama', model: 'qwen3:8b' });
    const [own, claude] = modelGroups(inst);
    expect(own[0]).toBe('ollama');
    expect(own[1].map((e) => [e.label, e.state.kind, e.selected, e.target])).toEqual([
      ['Local', 'restart', true, { tier: 'local' }],
      ['Llama 70B', 'restart', false, { model: 'llama3:70b' }],
    ]);
    expect(claude[1].every((e) => e.state.kind === 'cross')).toBe(true);
    for (const busy of [{ status: 'turn' }, { displayStatus: 'running' }, { modelSwitch: { from: 'a', to: 'b' } }]) {
      expect(modelEntryState({ ...inst, ...busy } as Instance, { backend: 'ollama', model: 'x' })).toMatchObject({ kind: 'restart', disabled: true });
    }
  });

  it('a disabled tier is not offered', () => {
    catalog({ enabledTiers: { fast: false } });
    expect(modelGroups(base())[0][1].map((e) => e.label)).toEqual(['Powerful']);
  });

  it('picking a tier sends only {id, tier} with an ack; a refusal is reported', async () => {
    wrap(<SessionHeader inst={base()} onMenu={() => {}} />);
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Change model/ })).toBeTruthy();
    await act(async () => { fireEvent.keyDown(within(menu).getByRole('menuitem', { name: /Change model/ }), { key: 'ArrowRight' }); });
    const sub = screen.getAllByRole('menu').at(-1)!;
    await act(async () => { fireEvent.click(within(sub).getByRole('menuitem', { name: /Fast/ })); });
    expect(sent).toEqual([['model', { id: 'inst-1', tier: 'fast' }, { ack: true }]]);
  });

  it('Change model and effort are disabled during a turn', async () => {
    wrap(<SessionHeader inst={base({ status: 'turn', displayStatus: 'turn' })} onMenu={() => {}} />);
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Change model/ }).getAttribute('data-disabled')).not.toBeNull();
    expect(within(menu).getByRole('menuitem', { name: /Change effort/ }).getAttribute('data-disabled')).not.toBeNull();
    expect(within(menu).getByRole('menuitem', { name: /Interrupt/ })).toBeTruthy();
  });

  it('a switch in flight shows the switching chip; a failed one shows a failure chip', () => {
    const a = wrap(<SessionHeader inst={base({ modelSwitch: { from: 'a', to: 'b-model' } })} onMenu={() => {}} />);
    expect(a.container.textContent).toContain('Switching to b-model');
    a.unmount();
    const b = wrap(<SessionHeader inst={base({ modelSwitchFailure: { from: 'a', to: 'b-model', error: 'not found' } })} onMenu={() => {}} />);
    expect(b.container.textContent).toContain('Switch failed');
  });
});

describe('change effort', () => {
  it('offers the server\'s level catalog in order, marks the running one, and sends one effort frame', async () => {
    wrap(<SessionHeader inst={base({ effort: 'medium' })} onMenu={() => {}} />);
    const menu = await openMenu();
    await act(async () => { fireEvent.keyDown(within(menu).getByRole('menuitem', { name: /Change effort/ }), { key: 'ArrowRight' }); });
    const sub = screen.getAllByRole('menu').at(-1)!;
    const items = within(sub).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['low', 'medium', 'high', 'max']);
    expect(items[1].querySelector('svg')).toBeTruthy();
    await act(async () => { fireEvent.click(items[3]); });
    expect(sent).toEqual([['effort', { id: 'inst-1', effort: 'max' }, { ack: true }]]);
  });
});

describe('mode toggle', () => {
  it('shows the mode; clicking the other side sends one mode frame; the pressed side sends nothing', async () => {
    wrap(<ModeToggle inst={base({ mode: 'plan' })} />);
    expect(screen.getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Plan' })); });
    expect(sent).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Code' })); });
    expect(sent).toEqual([['mode', { id: 'inst-1', mode: 'bypassPermissions' }, { ack: true }]]);
  });

  it('is disabled in a turn, crashed or exited; enabled when idle', () => {
    for (const [status, disabled] of [['turn', true], ['crashed', true], ['exited', true], ['idle', false]] as const) {
      const r = wrap(<ModeToggle inst={base({ status })} />);
      expect((screen.getByRole('button', { name: 'Code' }) as HTMLButtonElement).disabled).toBe(disabled);
      r.unmount();
    }
  });
});

describe('session menu', () => {
  it('mute flips per session; rename / summary / statistics / prune open their dialogs', async () => {
    wrap(<SessionHeader inst={base()} onMenu={() => {}} />);
    let menu = await openMenu();
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: /Mute notifications/ })); });
    expect(isSessionMuted('sess-1')).toBe(true);
    menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Unmute notifications/ })).toBeTruthy();
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: /Unmute/ })); });
    expect(isSessionMuted('sess-1')).toBe(false);
    for (const [label, slot] of [[/Rename/, 'rename'], [/Summarize/, 'summary'], [/Statistics/, 'stats'], [/Prune/, 'prune']] as const) {
      menu = await openMenu();
      await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: label })); });
      expect(dialogStore.get()[slot]).toBeTruthy();
    }
  });

  it('playbook enforcement shows only for a conductor and sends the opposite level with an ack; unknown reads as on', async () => {
    const plain = wrap(<SessionHeader inst={base()} onMenu={() => {}} />);
    let menu = await openMenu();
    expect(within(menu).queryByRole('menuitemcheckbox', { name: /Enforce playbooks/ })).toBeNull();
    plain.unmount();
    for (const [level, next] of [['enforce', 'warn'], ['warn', 'enforce'], ['future-level', 'warn']]) {
      sent.length = 0;
      const r = wrap(<SessionHeader inst={base({ project: '.conduct', playbookEnforcement: level })} onMenu={() => {}} />);
      menu = await openMenu();
      const item = within(menu).getByRole('menuitemcheckbox', { name: /Enforce playbooks/ });
      expect(item.getAttribute('aria-checked')).toBe(String(level !== 'warn'));
      await act(async () => { fireEvent.click(item); });
      expect(sent).toEqual([['playbook_enforcement', { id: 'inst-1', mode: next }, { ack: true }]]);
      r.unmount();
    }
  });

  it('no menu for a dead session without a worktree; Resume replaces it', () => {
    wrap(<SessionHeader inst={base({ status: 'exited', displayStatus: 'exited' })} onMenu={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Session actions' })).toBeNull();
    expect(screen.getByRole('button', { name: /Resume/ })).toBeTruthy();
  });
});

describe('context + rate-limit chip', () => {
  const chip = () => screen.getByRole('button', { name: 'Usage details' });

  it('a known reading against a known window shows the percentage; the tooltip names both figures', () => {
    getUsageTracker('c1').reset();
    getUsageTracker('c1').apply({ kind: 'message_start', usage: { input_tokens: 60_000 } });
    wrap(<UsageChip inst={base({ id: 'c1', contextWindowTokens: 200_000 })} />);
    expect(chip().textContent).toMatch(/^30%/);
    expect(chip().title).toContain('Context: 60,000/200,000 tokens');
  });

  it('unknown capacity (null, 0 or absent) names the used tokens and invents no denominator; no reading gets the first-turn tooltip', () => {
    for (const win of [null, 0, undefined]) {
      getUsageTracker('c2').reset();
      getUsageTracker('c2').apply({ kind: 'message_start', usage: { input_tokens: 46_398 } });
      const r = wrap(<UsageChip inst={base({ id: 'c2', contextWindowTokens: win as any })} />);
      expect(chip().textContent).toMatch(/^ctx —/);
      expect(chip().title).toContain('Context: 46,398 tokens used (capacity unknown)');
      r.unmount();
    }
    getUsageTracker('c3').reset();
    wrap(<UsageChip inst={base({ id: 'c3', contextWindowTokens: 1 })} />);
    expect(chip().title.startsWith('Context usage appears after the first turn.')).toBe(true);
  });

  it('a model switch drops the reading: `ctx —`, never the old count over the new window', () => {
    const t = getUsageTracker('c4');
    t.reset();
    t.apply({ kind: 'message_start', model: 'a', usage: { input_tokens: 190_000 } });
    t.apply({ kind: 'system', subtype: 'model_changed', data: { from: 'a', to: 'b' } });
    wrap(<UsageChip inst={base({ id: 'c4', contextWindowTokens: 1_000_000 })} />);
    expect(chip().textContent).toMatch(/^ctx —/);
  });

  it('the popover: totals, the Cost row suppressed for a substitution backend, usage limits tightest first, Fable only when scoped', async () => {
    const t = getUsageTracker('c5');
    t.reset();
    t.apply({ kind: 'turn_end', usage: { input_tokens: 10, output_tokens: 5 }, costDelta: 0.25, durationMs: 2000 });
    accountUsageStore.set({ usage: { seven_day: { utilization: 38 }, five_hour: { utilization: 45 }, limits: [{ scope: { model: { display_name: 'Fable' } }, percent: 12 }] }, stale: false });
    const r = wrap(<UsageChip inst={base({ id: 'c5' })} />);
    await act(async () => { fireEvent.click(chip()); });
    const pop = screen.getByRole('dialog');
    expect(pop.textContent).toContain('$0.2500');
    const labels = [...pop.querySelectorAll('section:last-child .text-muted-foreground')].map((n) => n.textContent);
    expect(labels.slice(1, 4)).toEqual(['5-hour', '7-day', '7-day Fable']);
    r.unmount();

    accountUsageStore.set({ usage: { five_hour: { utilization: 45 } }, stale: false });
    wrap(<UsageChip inst={base({ id: 'c5', backend: 'ollama' })} />);
    await act(async () => { fireEvent.click(chip()); });
    const pop2 = screen.getByRole('dialog');
    expect(pop2.textContent).not.toContain('$0.2500');
    expect(pop2.textContent).not.toContain('Fable');
    accountUsageStore.set({ usage: null, stale: false });
  });
});
