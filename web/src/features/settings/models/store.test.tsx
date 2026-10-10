import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  performProjectDelete: vi.fn(async () => {}),
  applySessionTitle: vi.fn(async () => 't'),
}));
vi.mock('@/lib/core/capabilities.js', () => ({
  loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true, fuseUnion: true })),
  capabilities: () => null,
}));

import { DialogsHost } from '@/features/dialogs/DialogsHost';
import { closeDialog, dialogStore, openSpawnDialog } from '@/features/dialogs/api';
import { appStore } from '@/state/app';
import { modelsSignal } from '@/app/models';
import {
  getActiveTierBackend, getActiveTierEnabled, setActiveDefaultSpawnTier, setActiveTierBackend, setActiveTierEnabled,
} from '@/lib/core/models.js';
import { routeFetch } from '@/test/routeFetch';
import { applyModelsPayload, modelsSettingsStore } from './store';
import type { ModelsPayload } from './logic';

const TIERS = [{ tier: 'fast', label: 'Quick' }, { tier: 'balanced', label: 'Balanced' }, { tier: 'powerful', label: 'Powerful' }, { tier: 'frontier', label: 'Frontier' }];

const P1: ModelsPayload = {
  tiers: TIERS,
  backends: [{ id: 'claude', label: 'Claude', managed: true }, { id: 'ollama', label: 'Ollama', managed: true }],
  tierBackend: { fast: { backend: 'ollama', model: 'qwen3:cloud' } },
  enabledTiers: { fast: true, balanced: false, powerful: true, frontier: true },
  defaultSpawnTier: 'powerful',
};

const P2: ModelsPayload = {
  tiers: [{ tier: 'fast', label: 'Fast' }, ...TIERS.slice(1)],
  backends: [{ id: 'claude', label: 'Claude', managed: true }, { id: 'ollama', label: 'Ollama', managed: true }],
  claudeFamilies: [{ family: 'sonnet', label: 'Sonnet', default: 'claude-sonnet-5-5', versions: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] }],
  tierBackend: { fast: { backend: 'claude', model: 'claude-sonnet-5-5' } },
  enabledTiers: { balanced: true, frontier: false },
  defaultSpawnTier: 'powerful',
};

const P3: ModelsPayload = {
  ...P1,
  tierBackend: { fast: { backend: 'ollama', model: 'other:cloud' } },
  enabledTiers: { ...P1.enabledTiers, powerful: false },
};

const radios = () => [...document.querySelectorAll<HTMLElement>('[role="radio"][data-tier]')];
const radioTiers = () => radios().map((r) => r.getAttribute('data-tier'));
const fastRadio = () => radios().find((r) => r.getAttribute('data-tier') === 'fast')!;

beforeEach(() => {
  setActiveTierEnabled({ fast: true, balanced: true, powerful: true, frontier: true });
  setActiveTierBackend({ fast: { backend: 'claude', model: 'claude-haiku-4-5' } });
  setActiveDefaultSpawnTier('powerful');
  modelsSettingsStore.set({ data: null, error: null, status: null });
  appStore.set({ projects: [{ name: 'p', path: '/w/p', system: 'local', remoteId: null, worktrees: [], isGitRepo: true, unbornHead: false }] as any });
  routeFetch({ 'GET /api/settings/spawn': () => ({ json: { debugByDefault: false } }) });
});
afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.unstubAllGlobals();
});

describe('Models payload', () => {
  // The saved payload reaches the settings store and the model cache, the cache is current by the time the signal fires, and an open New session dialog re-renders from it (tiers offered, tier label, model sublabel).
  it('a Models save hands its payload to the settings view and the model cache before the signal, and an open New session dialog re-reads it', () => {
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    const seen: unknown[][] = [];
    const off = modelsSignal.subscribe(() => seen.push([getActiveTierBackend('fast').model, getActiveTierEnabled('balanced')]));
    try {
      act(() => applyModelsPayload(P1));
      expect(modelsSettingsStore.get().data === P1).toBe(true);
      expect(seen).toEqual([['qwen3:cloud', false]]);
      expect(radioTiers()).toEqual(['fast', 'powerful', 'frontier']);
      expect(fastRadio().textContent).toContain('Quick');
      expect(fastRadio().textContent).toContain('qwen3:cloud');

      act(() => applyModelsPayload(P2));
      expect(seen.length).toBe(2);
      expect(seen[1]).toEqual(['claude-sonnet-5-5', true]);
      expect(radioTiers()).toEqual(['fast', 'balanced', 'powerful']);
      expect(fastRadio().textContent).toContain('Sonnet 5.5');
    } finally {
      off();
    }
  });

  // A refreshCatalog=false save updates only the settings store: no signal, the model cache keeps its enablement and bindings, and the open dialog offers the same tiers.
  it('a prefs-only save updates the settings view but leaves the model cache and the New session dialog alone', () => {
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    const seen: unknown[][] = [];
    const off = modelsSignal.subscribe(() => seen.push([getActiveTierBackend('fast').model, getActiveTierEnabled('balanced')]));
    try {
      act(() => applyModelsPayload(P1));
      expect(seen.length).toBe(1);

      act(() => applyModelsPayload(P3, false));
      expect(modelsSettingsStore.get().data === P3).toBe(true);
      expect(seen.length).toBe(1);
      expect(getActiveTierEnabled('powerful')).toBe(true);
      expect(getActiveTierBackend('fast').model).toBe('qwen3:cloud');
      expect(radioTiers()).toEqual(['fast', 'powerful', 'frontier']);
    } finally {
      off();
    }
  });
});
