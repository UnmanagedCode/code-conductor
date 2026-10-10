import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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
import { toast } from '@/ui/feedback';
import type { Instance } from '@/state/types';
import { ModeToggle, RESTART_BUSY_TITLE, SessionHeader, modelEntryState, modelGroups, runningBackendOf } from './SessionHeader';
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

// Each case below mirrors the named test in tests/header-change-model.test.mjs (the old UI's picker).
const ON_CLAUDE = 'Restarts the session on Claude. The conversation is kept.';
const ON_OLLAMA = 'Restarts the session on Ollama. The conversation is kept.';
const ON_THIS_MODEL = 'Restarts the session on this model. The conversation is kept.';
const RESTART_NOTE = '↻ restarts the session · the conversation is kept';
const NONE_NOTE = 'No other model is available. Add one in Settings → Models.';
const ALL_CLAUDE = { fast: { backend: 'claude', model: 'claude-haiku-5-5' }, powerful: { backend: 'claude', model: 'claude-opus-5-5' }, local: { backend: 'claude', model: 'claude-sonnet-5-5' } };
const PROXY_BACKENDS = [{ id: 'claude', label: 'Claude' }, { id: 'ollama', label: 'Ollama' }, { id: 'my-proxy', label: 'My Proxy' }];

async function openModelPicker(inst: Instance) {
  wrap(<SessionHeader inst={inst} onMenu={() => {}} />);
  const menu = await openMenu();
  await act(async () => { fireEvent.keyDown(within(menu).getByRole('menuitem', { name: /Change model/ }), { key: 'ArrowRight' }); });
  return screen.getAllByRole('menu').at(-1)!;
}
const restartIcon = (item: HTMLElement) => item.querySelector('.lucide-refresh-cw');

describe('change model', () => {
  it('an identity session: Claude tiers switch live with no ↻; tiers on another backend restart onto it (mirrors "an identity session: Claude tiers switch live with no badge; tiers on another backend restart onto it")', async () => {
    const groups = modelGroups(base());
    expect(groups.map(([id]) => id)).toEqual(['claude', 'ollama']);
    const [claude, ollama] = groups;
    expect(claude[1].map((e) => [e.label, e.state.kind, e.state.disabled, e.selected])).toEqual([
      ['Fast', 'live', false, false], ['Powerful', 'live', false, true],
    ]);
    expect(ollama[1].map((e) => [e.label, e.state, e.selected, e.target])).toEqual([
      ['Local', { kind: 'restart', disabled: false, title: ON_OLLAMA }, false, { tier: 'local' }],
      ['Llama 70B', { kind: 'restart', disabled: false, title: ON_OLLAMA }, false, { model: 'llama3:70b', backend: 'ollama' }],
    ]);
    const sub = await openModelPicker(base());
    expect(restartIcon(within(sub).getByRole('menuitem', { name: /Powerful/ }))).toBeNull();
    expect(restartIcon(within(sub).getByRole('menuitem', { name: /Local/ }))).not.toBeNull();
    expect(sub.textContent).toContain(RESTART_NOTE);
  });

  it('an identity session mid-turn: its live Claude entries are disabled (mirrors "an identity session mid-turn: its live Claude tier entries are disabled until the turn ends")', () => {
    const claude = modelGroups(base({ status: 'turn' }))[0][1];
    expect(claude.map((e) => [e.state.kind, e.state.disabled, e.state.title])).toEqual([
      ['live', true, 'Model can only be changed between turns'], ['live', true, 'Model can only be changed between turns'],
    ]);
  });

  it('a substitution session: every tier restarts (↻ footnote); one on another backend names that backend (mirrors the same-named test)', async () => {
    const inst = base({ backend: 'ollama', model: 'qwen3:8b' });
    const [own, claude] = modelGroups(inst);
    expect(own[0]).toBe('ollama');
    expect(own[1].map((e) => [e.label, e.state.kind, e.state.title, e.selected, e.target])).toEqual([
      ['Local', 'restart', ON_THIS_MODEL, true, { tier: 'local' }],
      ['Llama 70B', 'restart', ON_THIS_MODEL, false, { model: 'llama3:70b', backend: 'ollama' }],
    ]);
    expect(claude[0]).toBe('claude');
    expect(claude[1].map((e) => [e.label, e.state.kind, e.state.disabled, e.state.title])).toEqual([
      ['Fast', 'restart', false, ON_CLAUDE], ['Powerful', 'restart', false, ON_CLAUDE],
    ]);
    const sub = await openModelPicker(inst);
    for (const name of [/Local/, /Llama 70B/, /Fast/, /Powerful/]) expect(restartIcon(within(sub).getByRole('menuitem', { name }))).not.toBeNull();
    expect(sub.textContent).toContain(RESTART_NOTE);
  });

  it('a restart click on a tier bound to another backend sends exactly {id, tier} (mirrors "… still sends only {t, id, tier, reqId}")', async () => {
    const sub = await openModelPicker(base());
    await act(async () => { fireEvent.click(within(sub).getByRole('menuitem', { name: /Local/ })); });
    expect(sent).toEqual([['model', { id: 'inst-1', tier: 'local' }, { ack: true }]]);
  });

  it('an Ollama session with every tier on Claude is offered its backend\'s registered models and the Claude tiers (mirrors the same-named test)', () => {
    catalog({ tierBackend: ALL_CLAUDE });
    const [own, claude] = modelGroups(base({ backend: 'ollama', model: 'qwen3:8b' }));
    expect(own[0]).toBe('ollama');
    expect(own[1].map((e) => [e.label, e.state.kind, e.state.disabled, e.selected, e.target])).toEqual([
      ['Qwen 8B', 'restart', false, true, { model: 'qwen3:8b', backend: 'ollama' }],
      ['Llama 70B', 'restart', false, false, { model: 'llama3:70b', backend: 'ollama' }],
    ]);
    expect(claude[0]).toBe('claude');
    expect(claude[1].map((e) => [e.label, e.state.kind, e.state.title])).toEqual([
      ['Fast', 'restart', ON_CLAUDE], ['Powerful', 'restart', ON_CLAUDE], ['Local', 'restart', ON_CLAUDE],
    ]);
  });

  it('a Claude session is offered other backends\' registered models; a click sends exactly {id, model, backend} (mirrors the same-named test)', async () => {
    catalog({ tierBackend: ALL_CLAUDE });
    const [claude, ollama] = modelGroups(base());
    expect(claude[0]).toBe('claude');
    expect(ollama[0]).toBe('ollama');
    expect(ollama[1].map((e) => [e.label, e.state, e.selected])).toEqual([
      ['Qwen 8B', { kind: 'restart', disabled: false, title: ON_OLLAMA }, false],
      ['Llama 70B', { kind: 'restart', disabled: false, title: ON_OLLAMA }, false],
    ]);
    const sub = await openModelPicker(base());
    await act(async () => { fireEvent.click(within(sub).getByRole('menuitem', { name: /Llama 70B/ })); });
    expect(sent).toEqual([['model', { id: 'inst-1', model: 'llama3:70b', backend: 'ollama' }, { ack: true }]]);
  });

  it('every registered backend is listed, in registry order, after the tiers (mirrors the same-named test)', () => {
    catalog({
      backends: PROXY_BACKENDS, tierBackend: ALL_CLAUDE,
      backendModels: { ollama: [{ model: 'qwen3:8b', label: 'Qwen 8B' }], 'my-proxy': [{ model: 'mine:v2', label: 'Mine' }] },
    });
    const groups = modelGroups(base());
    expect(groups.map(([id]) => id)).toEqual(['claude', 'ollama', 'my-proxy']);
    expect(groups[2][1].map((e) => [e.label, e.state.title, e.target])).toEqual([
      ['Mine', 'Restarts the session on My Proxy. The conversation is kept.', { model: 'mine:v2', backend: 'my-proxy' }],
    ]);
  });

  it('cross entries are disabled while busy: a turn, a running subagent, or a switch in flight (mirrors the same-named test)', () => {
    const cross = { backend: 'ollama', model: 'qwen3:8b' };
    expect(modelEntryState(base(), cross)).toEqual({ kind: 'restart', disabled: false, title: ON_OLLAMA });
    for (const busy of [{ status: 'turn', displayStatus: 'turn' }, { displayStatus: 'running' },
      { modelSwitch: { from: 'claude-haiku-5-5', to: 'claude-opus-5-5', fromBackend: 'claude', toBackend: 'claude' } }]) {
      expect(modelEntryState(base(busy as Partial<Instance>), cross)).toEqual({ kind: 'restart', disabled: true, title: RESTART_BUSY_TITLE });
    }
    const inst = base({ backend: 'ollama', model: 'qwen3:8b' });
    for (const busy of [{ status: 'turn' }, { displayStatus: 'running' }, { modelSwitch: { from: 'a', to: 'b' } }]) {
      expect(modelEntryState({ ...inst, ...busy } as Instance, { backend: 'ollama', model: 'x' })).toMatchObject({ kind: 'restart', disabled: true });
    }
  });

  it('the ✓ needs the running backend as well as the running model id (mirrors "the highlight needs …")', () => {
    catalog({
      backends: PROXY_BACKENDS, tierBackend: ALL_CLAUDE,
      backendModels: { ollama: [{ model: 'alpha:cloud', label: 'Alpha' }], 'my-proxy': [{ model: 'alpha:cloud', label: 'Alpha proxied' }] },
    });
    const groups = new Map(modelGroups(base({ backend: 'ollama', model: 'alpha:cloud' })));
    expect(groups.get('ollama')!.map((e) => [e.label, e.selected])).toEqual([['Alpha', true]]);
    expect(groups.get('my-proxy')!.map((e) => [e.label, e.selected, e.state.disabled])).toEqual([['Alpha proxied', false, false]]);
  });

  it('mid cross switch the running backend is the one the session is still on (mirrors the same-named test)', () => {
    const switching = base({ backend: 'ollama', model: 'alpha:cloud',
      modelSwitch: { from: 'claude-opus-5-5', to: 'alpha:cloud', fromBackend: 'claude', toBackend: 'ollama' } });
    expect(runningBackendOf(switching)).toBe('claude');
    expect(runningBackendOf({ ...switching, modelSwitch: null })).toBe('ollama');
    expect(runningBackendOf(base({ backend: undefined }))).toBe('claude');
    const claudeTier = { backend: 'claude', model: 'claude-opus-5-5' };
    expect(modelEntryState(switching, claudeTier).kind).toBe('live');
    expect(modelEntryState({ ...switching, modelSwitch: null }, claudeTier).kind).toBe('restart');
  });

  it('a cross switch\'s switching badge and failure tooltip name the target backend; a same-backend one\'s do not (mirrors "a cross switch\'s restarting and failure chips name both backends")', async () => {
    const cross = { from: 'claude-opus-5-5', to: 'alpha:cloud', fromBackend: 'claude', toBackend: 'ollama' };
    const same = { from: 'alpha:cloud', to: 'beta:cloud', fromBackend: 'ollama', toBackend: 'ollama' };
    const badge = (sw: typeof cross) => {
      const r = wrap(<SessionHeader inst={base({ status: 'exited', displayStatus: 'exited', modelSwitch: sw })} onMenu={() => {}} />);
      const text = [...r.container.querySelectorAll('[data-slot="badge"]')].map((n) => n.textContent);
      r.unmount();
      return text;
    };
    expect(badge(cross)).toContain('Switching to alpha:cloud on ollama');
    expect(badge(same)).toContain('Switching to beta:cloud');
    const tooltip = async (sw: typeof cross) => {
      const r = wrap(<SessionHeader inst={base({ modelSwitchFailure: { ...sw, error: 'boom' } })} onMenu={() => {}} />);
      await act(async () => { fireEvent.focus(screen.getByText('Switch failed')); });
      const text = (await screen.findByRole('tooltip')).textContent;
      r.unmount();
      return text;
    };
    expect(await tooltip(cross)).toBe('Switch to alpha:cloud on ollama failed: boom');
    expect(await tooltip(same)).toBe('Switch to beta:cloud failed: boom');
  });

  it('a picker with nothing but the running model says so, on any backend (mirrors "a picker with nothing but the running model says so — on any backend")', async () => {
    const ALL_ON = (backend: string, model: string) => ({ fast: { backend, model }, powerful: { backend, model }, local: { backend, model } });
    const note = async (inst: Instance) => {
      const sub = await openModelPicker(inst);
      const has = sub.textContent!.includes(NONE_NOTE);
      cleanup();
      return has;
    };
    catalog({ tierBackend: ALL_ON('ollama', 'qwen3:8b'), backendModels: { ollama: [] } });
    expect(await note(base({ backend: 'ollama', model: 'qwen3:8b' }))).toBe(true);
    catalog({ tierBackend: ALL_ON('claude', 'claude-opus-5-5'), backendModels: { ollama: [] } });
    expect(await note(base())).toBe(true);
    // Controls: one registered model on another backend, or a tier on another model, is a switch.
    catalog({ tierBackend: ALL_ON('claude', 'claude-opus-5-5'), backendModels: { ollama: [{ model: 'qwen3:8b', label: 'Qwen 8B' }] } });
    expect(await note(base())).toBe(false);
    catalog({ tierBackend: { ...ALL_ON('ollama', 'qwen3:8b'), powerful: { backend: 'claude', model: 'claude-opus-5-5' } }, backendModels: { ollama: [] } });
    expect(await note(base({ backend: 'ollama', model: 'qwen3:8b' }))).toBe(false);
  });

  it('a disabled tier is not offered', () => {
    catalog({ enabledTiers: { fast: false } });
    expect(modelGroups(base())[0][1].map((e) => e.label)).toEqual(['Powerful']);
  });

  it('picking a tier sends only {id, tier} with an ack', async () => {
    wrap(<SessionHeader inst={base()} onMenu={() => {}} />);
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Change model/ })).toBeTruthy();
    await act(async () => { fireEvent.keyDown(within(menu).getByRole('menuitem', { name: /Change model/ }), { key: 'ArrowRight' }); });
    const sub = screen.getAllByRole('menu').at(-1)!;
    await act(async () => { fireEvent.click(within(sub).getByRole('menuitem', { name: /Fast/ })); });
    expect(sent).toEqual([['model', { id: 'inst-1', tier: 'fast' }, { ack: true }]]);
  });

  it('a refused pick shows the server\'s reason in a "Change model failed" toast (mirrors "a refused restart is shown inside the open picker — no alert()")', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    ackReply = () => Promise.reject(new Error('session is busy: a background job is running'));
    try {
      const sub = await openModelPicker(base({ backend: 'ollama', model: 'qwen3:8b' }));
      await act(async () => { fireEvent.click(within(sub).getByRole('menuitem', { name: /Llama 70B/ })); });
      expect(sent).toEqual([['model', { id: 'inst-1', model: 'llama3:70b', backend: 'ollama' }, { ack: true }]]);
      expect(error.mock.calls).toEqual([['Change model failed', 'session is busy: a background job is running']]);
    } finally { error.mockRestore(); }
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

  it('the popover names a session with no known model `(account default)` (mirrors header-change-model "the usage popover names a session with no known model `(account default)`")', async () => {
    getUsageTracker('c6').reset();
    wrap(<UsageChip inst={base({ id: 'c6', model: null })} />);
    await act(async () => { fireEvent.click(chip()); });
    expect(screen.getByRole('dialog').textContent).toContain('(account default)');
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
