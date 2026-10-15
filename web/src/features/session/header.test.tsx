import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const sent: [string, any, any][] = [];
let ackReply: (t: string) => Promise<unknown> = () => Promise.resolve({ ok: true });
vi.mock('@shared/ws', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (t: string, payload: any, opts: any = {}) => { sent.push([t, payload, opts]); return opts.ack ? ackReply(t) : undefined; },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { applyModelsPayload } from '@shared/models';
import { getUsageTracker } from '@/app/trackers';
import { accountUsageStore } from '@/app/accountUsage';
import { isSessionMuted, muteSession } from '@/features/notifications/mutes';
import { closeDialog, dialogStore } from '@/features/dialogs/api';
import { applyModels } from '@/app/models';
import { ConfirmHost, toast } from '@/ui/feedback';
import { stickyPrompt } from '@/app/controller';
import { SWIPE_MIN_PX } from '@/conversation/stickyPrompt';
import type { Instance } from '@/state/types';
import type { UiEvent } from '@shared/uiEvent';
import { turnEnd } from '@/conversation/testkit';
import { ModeToggle, RESTART_BUSY_TITLE, SessionHeader, modelEntryState, modelGroups, runningBackendOf } from './SessionHeader';
import { UsageChip } from './UsageChip';
import { Dot } from '@/features/sidebar/rows';

const base = (extra: Partial<Instance> = {}): Instance => ({
  id: 'inst-1', project: 'demo', status: 'idle', displayStatus: 'idle', sessionId: 'sess-1', mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000, ...extra,
});

const PAYLOAD = {
  tiers: [{ tier: 'fast', label: 'Fast' }, { tier: 'powerful', label: 'Powerful' }, { tier: 'local', label: 'Local' }],
  backends: [{ id: 'claude', label: 'Claude' }, { id: 'ollama', label: 'Ollama' }],
  tierBackend: { fast: { backend: 'claude', model: 'claude-haiku-5-5' }, powerful: { backend: 'claude', model: 'claude-opus-5-5' }, local: { backend: 'ollama', model: 'qwen3:8b' } },
  enabledTiers: { fast: true, powerful: true, local: true },
  efforts: ['low', 'medium', 'high', 'max'],
  backendModels: { ollama: [{ model: 'qwen3:8b', label: 'Qwen 8B' }, { model: 'llama3:70b', label: 'Llama 70B' }] },
};
function catalog(extra: object = {}) {
  applyModelsPayload({ ...PAYLOAD, ...extra });
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

/** A header that stays mounted: `update` re-renders the same tree with new session data. */
function mountHeader(inst: Instance) {
  const r = wrap(<SessionHeader inst={inst} onMenu={() => {}} />);
  return { ...r, update: (next: Instance) => r.rerender(<TooltipProvider><SessionHeader inst={next} onMenu={() => {}} /></TooltipProvider>) };
}
const menuItem = (menu: HTMLElement, name: RegExp) => within(menu).getByRole('menuitem', { name });
const isDisabled = (el: HTMLElement) => el.hasAttribute('data-disabled');
/** Opens the submenu under `trigger`; returns it. */
async function openSub(trigger: HTMLElement) {
  await act(async () => { fireEvent.keyDown(trigger, { key: 'ArrowRight' }); });
  return screen.getAllByRole('menu').at(-1)!;
}

beforeEach(() => {
  sent.length = 0;
  ackReply = () => Promise.resolve({ ok: true });
  catalog();
});

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
const restartIcon = (item: HTMLElement) => item.querySelector('[data-restart-mark]');

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
      ['Qwen 8B', { kind: 'restart', disabled: false, title: ON_OLLAMA }, false, { model: 'qwen3:8b', backend: 'ollama' }],
      ['Llama 70B', { kind: 'restart', disabled: false, title: ON_OLLAMA }, false, { model: 'llama3:70b', backend: 'ollama' }],
    ]);
    // Invariant: in the open picker only the entries that restart carry the restart mark: Local, Qwen 8B and Llama 70B, never the live Claude tiers.
    const sub = await openModelPicker(base());
    expect(restartIcon(within(sub).getByRole('menuitem', { name: /Powerful/ }))).toBeNull();
    expect(restartIcon(within(sub).getByRole('menuitem', { name: /Local/ }))).not.toBeNull();
    expect(sub.querySelectorAll('[data-restart-mark]')).toHaveLength(3);
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
      ['Local', 'restart', ON_THIS_MODEL, false, { tier: 'local' }],
      ['Qwen 8B', 'restart', ON_THIS_MODEL, true, { model: 'qwen3:8b', backend: 'ollama' }],
      ['Llama 70B', 'restart', ON_THIS_MODEL, false, { model: 'llama3:70b', backend: 'ollama' }],
    ]);
    expect(claude[0]).toBe('claude');
    expect(claude[1].map((e) => [e.label, e.state.kind, e.state.disabled, e.state.title])).toEqual([
      ['Fast', 'restart', false, ON_CLAUDE], ['Powerful', 'restart', false, ON_CLAUDE],
    ]);
    // Invariant: on a substitution session each of the five entries carries the restart mark, and nothing else in the picker does.
    const sub = await openModelPicker(inst);
    for (const name of [/Local/, /Qwen 8B/, /Llama 70B/, /Fast/, /Powerful/]) expect(restartIcon(within(sub).getByRole('menuitem', { name }))).not.toBeNull();
    expect(sub.querySelectorAll('[data-restart-mark]')).toHaveLength(5);
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
    // A tier and a registered model on the running model: every entry still lands on it, so the note stays.
    catalog({ tierBackend: ALL_ON('ollama', 'qwen3:8b'), backendModels: { ollama: [{ model: 'qwen3:8b', label: 'Qwen 8B' }] } });
    expect(await note(base({ backend: 'ollama', model: 'qwen3:8b' }))).toBe(true);
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

  it('the Change model label is static whatever the running model, and idle with a session it is enabled and titled', async () => {
    // Invariant: across running models (null included) the Change model label is one value that names no model family, and idle with a session the item is enabled with a non-empty title that is not the between-turns reason.
    const models = ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', null];
    const labels = new Set<string>();
    let seen = 0;
    for (const model of models) {
      const r = wrap(<SessionHeader inst={base({ model })} onMenu={() => {}} />);
      const trigger = menuItem(await openMenu(), /Change model/);
      const label = trigger.textContent!.trim();
      labels.add(label);
      seen++;
      expect(label, `model ${model}`).not.toMatch(/opus|haiku|sonnet|claude/i);
      expect(isDisabled(trigger), `model ${model}`).toBe(false);
      expect(trigger.title, `model ${model}`).toBeTruthy();
      expect(trigger.title, `model ${model}`).not.toMatch(/between turns/i);
      r.unmount();
    }
    expect(seen).toBe(models.length);
    expect([...labels]).toHaveLength(1);
    expect([...labels][0]).toMatch(/change model/i);
  });

  it('Change model is disabled with the between-turns title during a turn and re-enabled at turn end, on a Claude and a substitution session', async () => {
    // Invariant: on either backend a turn disables Change model (and Change effort) with a title giving the between-turns reason, and turn end re-enables it with a non-empty title that drops that reason.
    let seen = 0;
    for (const backend of ['claude', 'ollama']) {
      const inst = base(backend === 'claude' ? {} : { backend, model: 'qwen3:8b' });
      const h = mountHeader({ ...inst, status: 'turn', displayStatus: 'turn' });
      const menu = await openMenu();
      expect(isDisabled(menuItem(menu, /Change model/)), `${backend} turn`).toBe(true);
      expect(menuItem(menu, /Change model/).title, `${backend} turn`).toMatch(/between turns/i);
      expect(isDisabled(menuItem(menu, /Change effort/)), `${backend} turn`).toBe(true);
      h.update(inst);
      expect(isDisabled(menuItem(menu, /Change model/)), `${backend} idle`).toBe(false);
      expect(menuItem(menu, /Change model/).title, `${backend} idle`).toBeTruthy();
      expect(menuItem(menu, /Change model/).title, `${backend} idle`).not.toMatch(/between turns/i);
      h.unmount();
      seen++;
    }
    expect(seen).toBe(2);
  });

  it('an open picker follows the session: a turn disables its restart and registered-model entries with the busy title, and idle re-enables them in the same open picker', async () => {
    const h = mountHeader(base());
    const sub = await openSub(menuItem(await openMenu(), /Change model/));
    for (const name of [/Local/, /Llama 70B/]) expect(isDisabled(menuItem(sub, name))).toBe(false);
    h.update(base({ status: 'turn', displayStatus: 'turn' }));
    expect(sub.isConnected).toBe(true);
    for (const name of [/Local/, /Llama 70B/]) {
      expect(isDisabled(menuItem(sub, name)), String(name)).toBe(true);
      expect(menuItem(sub, name).title, String(name)).toBe(RESTART_BUSY_TITLE);
    }
    h.update(base());
    expect(sub.isConnected).toBe(true);
    for (const name of [/Local/, /Llama 70B/]) expect(isDisabled(menuItem(sub, name)), String(name)).toBe(false);
  });

  it('a restart pick sends exactly {id, tier} and closes the picker and the menu', async () => {
    const sub = await openModelPicker(base());
    await act(async () => { fireEvent.click(menuItem(sub, /Local/)); });
    expect(sent).toEqual([['model', { id: 'inst-1', tier: 'local' }, { ack: true }]]);
    expect(screen.queryAllByRole('menu')).toEqual([]);
  });

  it('a re-render with unchanged entry states keeps the very same menu items', async () => {
    const h = mountHeader(base());
    const sub = await openSub(menuItem(await openMenu(), /Change model/));
    const before = menuItem(sub, /Fast/);
    h.update(base({ title: 'renamed' }));
    expect(menuItem(sub, /Fast/)).toBe(before);
  });

  it('a registered model a tier on its backend also binds is offered both as the tier and as the model; each sends its own frame', async () => {
    const ollama = new Map(modelGroups(base())).get('ollama')!;
    expect(ollama.find((e) => e.label === 'Local')?.target).toEqual({ tier: 'local' });
    expect(ollama.map((e) => [e.label, e.target])).toEqual([
      ['Local', { tier: 'local' }],
      ['Qwen 8B', { model: 'qwen3:8b', backend: 'ollama' }],
      ['Llama 70B', { model: 'llama3:70b', backend: 'ollama' }],
    ]);
    expect(ollama.filter((e) => e.model === 'qwen3:8b')).toHaveLength(2);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let sub = await openModelPicker(base());
      expect(within(sub).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Fast', 'Powerful', 'Local', 'Qwen 8B', 'Llama 70B']);
      await act(async () => { fireEvent.click(menuItem(sub, /Qwen 8B/)); });
      expect(sent).toEqual([['model', { id: 'inst-1', model: 'qwen3:8b', backend: 'ollama' }, { ack: true }]]);
      cleanup();
      sent.length = 0;
      sub = await openModelPicker(base());
      await act(async () => { fireEvent.click(menuItem(sub, /Local/)); });
      expect(sent).toEqual([['model', { id: 'inst-1', tier: 'local' }, { ack: true }]]);
      expect(errors.mock.calls.filter((c) => /same key/.test(String(c[0])))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('when a tier and a listed registered model both resolve to the running model, only the registered entry carries the ✓', async () => {
    const checked = (sub: HTMLElement) => within(sub).getAllByRole('menuitem').filter((i) => i.querySelector('svg:not([data-restart-mark])')).map((i) => i.textContent);
    const inst = base({ backend: 'ollama', model: 'qwen3:8b' });
    const group = () => new Map(modelGroups(inst)).get('ollama')!;
    expect(group().find((e) => e.label === 'Llama 70B')?.selected).toBe(false);
    expect(group().map((e) => [e.label, e.selected])).toEqual([['Local', false], ['Qwen 8B', true], ['Llama 70B', false]]);
    expect(checked(await openModelPicker(inst))).toEqual(['Qwen 8B']);
    cleanup();
    catalog({ backendModels: { ollama: [{ model: 'llama3:70b', label: 'Llama 70B' }] } });
    expect(group().map((e) => [e.label, e.selected])).toEqual([['Local', true], ['Llama 70B', false]]);
    expect(checked(await openModelPicker(inst))).toEqual(['Local']);
    cleanup();
    catalog();
    expect(checked(await openModelPicker(base()))).toEqual(['Powerful']);
  });

  it('a model id registered only on another backend never clears the ✓ of a tier that resolves to it on the running backend', async () => {
    // Invariant: the ✓-clearing is per backend: a tier's ✓ yields only to a registered entry in its own backend group.
    catalog({ backends: PROXY_BACKENDS, backendModels: { ollama: [], 'my-proxy': [{ model: 'qwen3:8b', label: 'Proxy Qwen' }] } });
    const inst = base({ backend: 'ollama', model: 'qwen3:8b' });
    const groups = new Map(modelGroups(inst));
    expect(groups.get('ollama')!.map((e) => [e.label, e.selected])).toEqual([['Local', true]]);
    expect(groups.get('my-proxy')!.map((e) => [e.label, e.selected])).toEqual([['Proxy Qwen', false]]);
    const sub = await openModelPicker(inst);
    expect(within(sub).getAllByRole('menuitem').filter((i) => i.querySelector('svg:not([data-restart-mark])')).map((i) => i.textContent)).toEqual(['Local']);
  });

  it('a models payload applied while the picker is open replaces its registered models: an added one appears, a removed one goes', async () => {
    const reg = (...names: string[]) => ({ ollama: names.map((n) => ({ model: n.toLowerCase(), label: n })) });
    catalog({ tierBackend: ALL_CLAUDE, backendModels: reg('Alpha', 'Beta', 'Gamma') });
    const sub = await openModelPicker(base());
    const labels = () => within(sub).getAllByRole('menuitem').map((i) => i.textContent);
    expect(labels()).toEqual(['Fast', 'Powerful', 'Local', 'Alpha', 'Beta', 'Gamma']);
    act(() => applyModels({ ...PAYLOAD, tierBackend: ALL_CLAUDE, backendModels: reg('Beta', 'Delta') }));
    expect(labels()).toEqual(['Fast', 'Powerful', 'Local', 'Beta', 'Delta']);
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

  it('Change effort is a ⋮ item whose label is static whatever the level', async () => {
    // Invariant: at every level (none included) ⋮ holds a Change effort item whose label is one value that never names the running level.
    const efforts = ['low', 'medium', 'high', 'max', undefined];
    const labels = new Set<string>();
    let seen = 0;
    for (const effort of efforts) {
      const r = wrap(<SessionHeader inst={base({ effort })} onMenu={() => {}} />);
      const label = menuItem(await openMenu(), /Change effort/).textContent!.trim();
      labels.add(label);
      seen++;
      if (effort) expect(label, `effort ${effort}`).not.toMatch(new RegExp(`\\b${effort}\\b`, 'i'));
      r.unmount();
    }
    expect(seen).toBe(efforts.length);
    expect([...labels]).toHaveLength(1);
    expect([...labels][0]).toMatch(/change effort/i);
  });

  it('Change effort is enabled only idle with a session, titled for why; a turn or a spawn disables it with the between-turns title', async () => {
    // Invariant: idle with a session Change effort is enabled with a non-empty title that is not the between-turns reason; a turn or a spawn disables it with a title giving that reason; no session disables it.
    const effortItem = async (inst: Instance) => {
      const r = wrap(<SessionHeader inst={inst} onMenu={() => {}} />);
      const item = menuItem(await openMenu(), /Change effort/);
      const got = { disabled: isDisabled(item), title: item.title };
      r.unmount();
      return got;
    };
    const idle = await effortItem(base());
    expect(idle.disabled).toBe(false);
    expect(idle.title).toBeTruthy();
    expect(idle.title).not.toMatch(/between turns/i);
    for (const status of ['turn', 'spawning']) {
      const busy = await effortItem(base({ status, displayStatus: status }));
      expect(busy.disabled, status).toBe(true);
      expect(busy.title, status).toMatch(/between turns/i);
    }
    expect((await effortItem(base({ sessionId: null }))).disabled).toBe(true);
  });

  it('exactly one level carries the check: the running one', async () => {
    for (const effort of ['low', 'medium', 'high', 'max']) {
      const r = wrap(<SessionHeader inst={base({ effort })} onMenu={() => {}} />);
      const sub = await openSub(menuItem(await openMenu(), /Change effort/));
      const checked = within(sub).getAllByRole('menuitem').filter((i) => i.querySelector('svg')).map((i) => i.textContent);
      expect(checked, `effort ${effort}`).toEqual([effort]);
      r.unmount();
    }
  });

  it('a substitution session is offered every level, with no backend note, and a pick sends one effort frame and closes the picker and the menu', async () => {
    wrap(<SessionHeader inst={base({ backend: 'ollama', model: 'qwen3:8b' })} onMenu={() => {}} />);
    const sub = await openSub(menuItem(await openMenu(), /Change effort/));
    const items = within(sub).getAllByRole('menuitem');
    expect(items.map((i) => [i.textContent, isDisabled(i)])).toEqual([['low', false], ['medium', false], ['high', false], ['max', false]]);
    expect(sub.textContent).toBe('lowmediumhighmax');
    await act(async () => { fireEvent.click(items[0]); });
    expect(sent).toEqual([['effort', { id: 'inst-1', effort: 'low' }, { ack: true }]]);
    expect(screen.queryAllByRole('menu')).toEqual([]);
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

  it('a click on the other side sends one frame and does not flip the pressed side until the session reports the mode', async () => {
    const h = mountHeader(base({ mode: 'bypassPermissions' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Plan' })); });
    expect(sent).toEqual([['mode', { id: 'inst-1', mode: 'plan' }, { ack: true }]]);
    expect(screen.getByRole('button', { name: 'Code' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe('false');
    h.update(base({ mode: 'plan' }));
    expect(screen.getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Code' }).getAttribute('aria-pressed')).toBe('false');
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

  // Debug capture reports the debug dir on success; the route's own {ok:false, reason} 500 shows that reason; a non-JSON 502 shows its status, never a parse error.
  it('Start debug capture: success names the dir, the route\'s refusal shows its reason, and an HTML 502 shows HTTP 502', async () => {
    const answers = [
      new Response(JSON.stringify({ ok: true, debugDir: '/tmp/dbg-7' })),
      new Response(JSON.stringify({ ok: false, reason: 'failed to open debug streams' }), { status: 500 }),
      new Response('<html>bad gateway</html>', { status: 502 }),
    ];
    const calls: [string, string | undefined][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push([url, init?.method]); return answers.shift()!; }));
    const ok = vi.spyOn(toast, 'success').mockImplementation(() => '' as any);
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '' as any);
    try {
      wrap(<SessionHeader inst={base()} onMenu={() => {}} />);
      for (let i = 0; i < 3; i++) {
        const menu = await openMenu();
        await act(async () => { fireEvent.click(menuItem(menu, /debug capture/i)); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      }
      expect(calls).toEqual(Array(3).fill(['/api/instances/inst-1/debug', 'POST']));
      expect(ok.mock.calls).toEqual([['Debug capture started', 'Writing to /tmp/dbg-7']]);
      expect(err.mock.calls).toEqual([
        ['Could not enable debug capture', 'failed to open debug streams'],
        ['Could not enable debug capture', 'HTTP 502'],
      ]);
    } finally {
      ok.mockRestore();
      err.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('no menu for a dead session without a worktree; Resume replaces it', () => {
    wrap(<SessionHeader inst={base({ status: 'exited', displayStatus: 'exited' })} onMenu={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Session actions' })).toBeNull();
    expect(screen.getByRole('button', { name: /Resume/ })).toBeTruthy();
  });

  it('while ⋮ stays open its items follow the session: a turn disables Prune with the between-turns title and makes Terminate Interrupt, and muting flips the label', async () => {
    // Invariant: in the same open ⋮, a turn disables Prune with a title giving the between-turns reason and swaps Terminate for Interrupt; idle re-enables Prune with a non-empty title without that reason and swaps back; muting swaps Mute for Unmute.
    const h = mountHeader(base());
    const menu = await openMenu();
    const item = (name: RegExp) => within(menu).queryByRole('menuitem', { name });
    try {
      expect(menuItem(menu, /Prune/).title).toBeTruthy();
      expect(menuItem(menu, /Prune/).title).not.toMatch(/between turns/i);
      expect(item(/^Terminate$/)).not.toBeNull();
      expect(item(/^Interrupt$/)).toBeNull();
      h.update(base({ status: 'turn', displayStatus: 'turn' }));
      expect(menu.isConnected).toBe(true);
      expect(isDisabled(menuItem(menu, /Prune/))).toBe(true);
      expect(menuItem(menu, /Prune/).title).toMatch(/between turns/i);
      expect(item(/^Interrupt$/)).not.toBeNull();
      expect(item(/^Terminate$/)).toBeNull();
      h.update(base());
      expect(menu.isConnected).toBe(true);
      expect(isDisabled(menuItem(menu, /Prune/))).toBe(false);
      expect(menuItem(menu, /Prune/).title).toBeTruthy();
      expect(menuItem(menu, /Prune/).title).not.toMatch(/between turns/i);
      expect(item(/^Terminate$/)).not.toBeNull();
      expect(item(/^Interrupt$/)).toBeNull();
      expect(item(/^Mute notifications/)).not.toBeNull();
      expect(item(/^Unmute/)).toBeNull();
      act(() => muteSession('sess-1', true));
      expect(menu.isConnected).toBe(true);
      expect(item(/^Unmute notifications/)).not.toBeNull();
      expect(item(/^Mute/)).toBeNull();
    } finally { act(() => muteSession('sess-1', false)); }
  });

  it('playbook enforcement follows the conductor\'s level while the header stays mounted', async () => {
    const conductor = (playbookEnforcement: string) => base({ project: '.conduct', playbookEnforcement });
    const h = mountHeader(conductor('enforce'));
    const menu = await openMenu();
    const checked = () => within(menu).getByRole('menuitemcheckbox', { name: /Enforce playbooks/ }).getAttribute('aria-checked');
    expect(checked()).toBe('true');
    h.update(conductor('warn'));
    expect(checked()).toBe('false');
    h.update(conductor('enforce'));
    expect(checked()).toBe('true');
    expect(sent).toEqual([]);
  });

  it('the deliberate close paths close ⋮: Escape, the trigger again, an item pick, and a press outside', async () => {
    closeDialog('summary');
    wrap(<SessionHeader inst={base()} onMenu={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Session actions' });
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const open = () => screen.queryAllByRole('menu');

    let menu = await openMenu();
    await act(async () => { fireEvent.keyDown(menu, { key: 'Escape' }); });
    expect(open(), 'Escape').toEqual([]);

    await openMenu();
    await settle();
    await act(async () => { fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false }); });
    expect(open(), 'the trigger again').toEqual([]);

    menu = await openMenu();
    let writes = 0;
    const off = dialogStore.subscribe(() => { writes++; });
    await act(async () => { fireEvent.click(menuItem(menu, /Summarize/)); });
    off();
    expect(open(), 'an item pick').toEqual([]);
    expect(writes).toBe(1);
    expect(dialogStore.get().summary).toEqual({ sessionId: 'sess-1' });
    closeDialog('summary');

    await openMenu();
    await settle();
    await act(async () => { fireEvent.pointerDown(document.body); });
    expect(open(), 'a press outside').toEqual([]);
  });

  it('Terminate, or Interrupt mid-turn, is the last ⋮ item and never a bar button', async () => {
    for (const [status, label] of [['idle', 'Terminate'], ['turn', 'Interrupt']] as const) {
      const r = wrap(<SessionHeader inst={base({ status, displayStatus: status })} onMenu={() => {}} />);
      expect(screen.queryByRole('button', { name: /Terminate|Interrupt/ }), `${status}, closed`).toBeNull();
      const menu = await openMenu();
      expect(within(menu).getAllByRole('menuitem').at(-1)!.textContent!.trim(), status).toBe(label);
      expect(screen.queryByRole('button', { name: /Terminate|Interrupt/ }), `${status}, open`).toBeNull();
      r.unmount();
    }
  });

  it('with no turn running, Terminate asks first: Cancel sends nothing, confirming sends one kill; mid-turn Interrupt sends interrupt without asking', async () => {
    const r = wrap(<><SessionHeader inst={base()} onMenu={() => {}} /><ConfirmHost /></>);
    const terminate = async () => {
      await act(async () => { fireEvent.click(menuItem(await openMenu(), /Terminate/)); });
      return screen.getByRole('dialog', { name: 'Terminate this session?' });
    };
    let dialog = await terminate();
    expect(sent).toEqual([]);
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); });
    expect(sent).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    dialog = await terminate();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Terminate' })); });
    expect(sent).toEqual([['kill', { id: 'inst-1' }, {}]]);
    r.unmount();

    sent.length = 0;
    wrap(<><SessionHeader inst={base({ status: 'turn', displayStatus: 'turn' })} onMenu={() => {}} /><ConfirmHost /></>);
    await act(async () => { fireEvent.click(menuItem(await openMenu(), /Interrupt/)); });
    expect(sent).toEqual([['interrupt', { id: 'inst-1' }, {}]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('context + rate-limit chip', () => {
  const chip = () => screen.getByRole('button', { name: 'Usage details' });

  it('a known reading against a known window shows the percentage; the tooltip names both figures', () => {
    getUsageTracker('c1').reset();
    getUsageTracker('c1').apply({ kind: 'message_start', msgId: 'm1', usage: { input_tokens: 60_000 } });
    wrap(<UsageChip inst={base({ id: 'c1', contextWindowTokens: 200_000 })} />);
    expect(chip().textContent).toMatch(/^30%/);
    expect(chip().title).toContain('Context: 60,000/200,000 tokens');
  });

  it('unknown capacity (null, 0 or absent) names the used tokens and invents no denominator; no reading gets the first-turn tooltip', () => {
    for (const win of [null, 0, undefined]) {
      getUsageTracker('c2').reset();
      getUsageTracker('c2').apply({ kind: 'message_start', msgId: 'm1', usage: { input_tokens: 46_398 } });
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
    t.apply({ kind: 'message_start', msgId: 'm1', model: 'a', usage: { input_tokens: 190_000 } });
    t.apply({ kind: 'system', subtype: 'model_changed', data: { from: 'a', to: 'b' } });
    wrap(<UsageChip inst={base({ id: 'c4', contextWindowTokens: 1_000_000 })} />);
    expect(chip().textContent).toMatch(/^ctx —/);
  });

  it('the popover names a session with no known model `(account default)`', async () => {
    getUsageTracker('c6').reset();
    wrap(<UsageChip inst={base({ id: 'c6', model: null })} />);
    await act(async () => { fireEvent.click(chip()); });
    expect(screen.getByRole('dialog').textContent).toContain('(account default)');
  });

  it('the popover: totals, the Cost row suppressed for a substitution backend, usage limits tightest first, Fable only when scoped', async () => {
    const t = getUsageTracker('c5');
    t.reset();
    t.apply(turnEnd({ usage: { input_tokens: 10, output_tokens: 5 }, costDelta: 0.25, durationMs: 2000 }));
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

  it('a window of 1 is a known capacity: the tooltip names 250,000/1 and never "capacity unknown"', () => {
    getUsageTracker('c7').reset();
    getUsageTracker('c7').apply({ kind: 'message_start', msgId: 'm1', usage: { input_tokens: 250_000 } });
    wrap(<UsageChip inst={base({ id: 'c7', contextWindowTokens: 1 })} />);
    expect(chip().title).toContain('Context: 250,000/1 tokens');
    expect(chip().title).not.toContain('capacity unknown');
    expect(chip().textContent).not.toMatch(/^ctx —/);
  });

  it('null usage blocks from message_start and context_usage leave `ctx —` and the first-turn tooltip', () => {
    const t = getUsageTracker('c8');
    t.reset();
    t.apply({ kind: 'message_start', msgId: 'm1', usage: null });
    // A null block the type forbids (the parser never emits one): pins the tracker's own `&& ev.usage` guard.
    t.apply({ kind: 'context_usage', msgId: 'm1', usage: null } as unknown as UiEvent);
    wrap(<UsageChip inst={base({ id: 'c8' })} />);
    expect(chip().textContent).toMatch(/^ctx —/);
    expect(chip().title.startsWith('Context usage appears after the first turn.')).toBe(true);
  });

  // The CLI's system/init names a Haiku session by its catalog id, the API's
  // message_start by its dated snapshot id, every turn (mirrors ctx-latch-model-switch D3).
  const HAIKU = 'claude-haiku-4-5';
  const HAIKU_U1 = { input_tokens: 10, cache_creation_input_tokens: 27_000, cache_read_input_tokens: 0 };
  const HAIKU_U2 = { input_tokens: 10, cache_creation_input_tokens: 229, cache_read_input_tokens: 27_040 };

  it('a Haiku session\'s alias/snapshot spelling pair keeps the reading through turn end', () => {
    const t = getUsageTracker('c9');
    t.reset();
    for (const usage of [HAIKU_U1, HAIKU_U2]) {
      t.apply({ kind: 'system', subtype: 'init', data: { model: HAIKU } });
      t.apply({ kind: 'message_start', msgId: 'm1', model: 'claude-haiku-4-5-20251001', usage });
      t.apply(turnEnd({ usage }));
    }
    wrap(<UsageChip inst={base({ id: 'c9', model: HAIKU, contextWindowTokens: 200_000 })} />);
    expect(chip().textContent).toMatch(/^14%/);
    expect(chip().title).toContain('27,279/200,000');
  });

  it('after a switch to a model with no known window, the carried window and the next reading render a percentage, not `ctx —`', () => {
    const t = getUsageTracker('c10');
    t.reset();
    t.apply({ kind: 'message_start', msgId: 'm1', model: HAIKU, usage: HAIKU_U1 });
    t.apply({ kind: 'system', subtype: 'model_changed', data: { from: HAIKU, to: 'claude-future-9' } });
    t.apply({ kind: 'message_start', msgId: 'm1', model: 'claude-future-9', usage: HAIKU_U2 });
    wrap(<UsageChip inst={base({ id: 'c10', model: 'claude-future-9', contextWindowTokens: 200_000 })} />);
    expect(chip().textContent).toMatch(/^14%/);
  });

  it('mid-switch the popover names the running model with no window clause; settled, it adds the window', async () => {
    const subline = async (inst: Instance) => {
      const r = wrap(<UsageChip inst={inst} />);
      await act(async () => { fireEvent.click(chip()); });
      const text = screen.getByRole('dialog').querySelector('section:first-child > .mt-1')!.textContent;
      r.unmount();
      return text;
    };
    getUsageTracker('c11').reset();
    const sw = { from: 'alpha:cloud', to: 'beta:cloud', fromBackend: 'ollama', toBackend: 'ollama' };
    expect(await subline(base({ id: 'c11', backend: 'ollama', model: 'beta:cloud', contextWindowTokens: 300_000, modelSwitch: sw }))).toBe('alpha:cloud');
    expect(await subline(base({ id: 'c11', backend: 'ollama', model: 'beta:cloud', contextWindowTokens: 300_000 }))).toBe('beta:cloud · 300k context');
  });

  it('the popover shows no Fable row when limits hold no Fable-scoped entry', async () => {
    getUsageTracker('c12').reset();
    accountUsageStore.set({ usage: { five_hour: { utilization: 45 }, limits: [{ scope: { model: { display_name: 'Opus' } }, percent: 12 }] }, stale: false });
    try {
      wrap(<UsageChip inst={base({ id: 'c12' })} />);
      await act(async () => { fireEvent.click(chip()); });
      const pop = screen.getByRole('dialog');
      expect(pop.textContent).toContain('5-hour');
      expect(pop.textContent).not.toContain('Fable');
    } finally { accountUsageStore.set({ usage: null, stale: false }); }
  });

  it('the popover says usage is unavailable, with no Fable row, when there is no account usage', async () => {
    getUsageTracker('c13').reset();
    accountUsageStore.set({ usage: null, stale: false });
    wrap(<UsageChip inst={base({ id: 'c13' })} />);
    await act(async () => { fireEvent.click(chip()); });
    const pop = screen.getByRole('dialog');
    expect(pop.textContent).toContain('Usage data unavailable.');
    expect(pop.textContent).not.toContain('Fable');
  });
});

describe('reveal swipe', () => {
  function touch(el: Element, type: string, points: { x: number; y: number }[]) {
    const ev = new Event(type, { bubbles: true }) as any;
    Object.defineProperty(ev, 'touches', { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
    el.dispatchEvent(ev);
  }

  it('a vertical swipe on the session header reveals (down) or conceals (up) the pinned prompt, including one that starts on a header button', () => {
    const reveal = vi.spyOn(stickyPrompt, 'reveal').mockImplementation(() => {});
    const conceal = vi.spyOn(stickyPrompt, 'conceal').mockImplementation(() => {});
    try {
      wrap(<SessionHeader inst={base()} onMenu={() => {}} />);
      const header = document.querySelector('[data-session-header]')!;
      touch(header, 'touchstart', [{ x: 0, y: 0 }]);
      touch(header, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }]);
      expect(reveal).toHaveBeenCalledTimes(1);
      const button = screen.getByRole('button', { name: 'Session actions' });
      touch(button, 'touchstart', [{ x: 0, y: 0 }]);
      touch(button, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }]);
      expect(reveal).toHaveBeenCalledTimes(2);
      touch(header, 'touchstart', [{ x: 0, y: 100 }]);
      touch(header, 'touchmove', [{ x: 0, y: 100 - SWIPE_MIN_PX }]);
      expect(conceal).toHaveBeenCalledTimes(1);
    } finally {
      reveal.mockRestore();
      conceal.mockRestore();
    }
  });
});

describe('status dot', () => {
  const headerDots = (container: HTMLElement) => container.querySelectorAll('[data-session-header] span[aria-label]');
  const rows: [string, Partial<Instance>, string][] = [
    ['idle + held wake is on a worker', { awaitingWake: true }, 'idle — waiting on a worker'],
    ['idle + background job', { waitingOnJob: true }, 'idle — waiting on a background job'],
    ['a worker wins over a job', { awaitingWake: true, waitingOnJob: true }, 'idle — waiting on a worker'],
    ['running outranks a held wake', { displayStatus: 'running', awaitingWake: true }, 'running'],
    ['plain idle invents no wait', {}, 'idle'],
    ['a turn reads running', { status: 'turn', displayStatus: 'turn' }, 'running'],
    ['spawning keeps its name', { status: 'spawning', displayStatus: 'spawning' }, 'spawning'],
    ['crashed keeps its name', { status: 'crashed', displayStatus: 'crashed' }, 'crashed'],
    ['exited keeps its name', { status: 'exited', displayStatus: 'exited' }, 'exited'],
    ['a question needs you', { awaitingUser: 'question', awaitingUserSource: 'tool' }, 'waiting on you (question) · idle'],
    ['a text ask names its source', { awaitingUser: 'question', awaitingUserSource: 'text' }, 'waiting on you (asked in text) · idle'],
    ['a question composes with on-a-worker', { awaitingUser: 'question', awaitingUserSource: 'tool', awaitingWake: true }, 'waiting on you (question) · on a worker'],
  ];
  it.each(rows)('%s', (_name, overrides, expected) => {
    const inst = base(overrides);
    const { container } = wrap(<SessionHeader inst={inst} onMenu={() => {}} />);
    const dots = headerDots(container);
    expect(dots).toHaveLength(1);
    const name = dots[0].getAttribute('aria-label');
    expect(name).toBe(expected);
    cleanup();
    const sidebar = wrap(<Dot status={inst.displayStatus ?? inst.status} awaitingWake={inst.awaitingWake} waitingOnJob={inst.waitingOnJob} awaitingUser={inst.awaitingUser} awaitingUserSource={inst.awaitingUserSource} />);
    expect(name).toBe(sidebar.container.querySelector('span[aria-label]')!.getAttribute('aria-label'));
  });
});
