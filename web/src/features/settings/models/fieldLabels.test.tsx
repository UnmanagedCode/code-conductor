import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch } from '../test/fetchMock';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));

import { modelsSettingsStore } from './store';
import { ModelsSection } from './ModelsSection';
import type { ModelsPayload } from './logic';

// Tier and role labels differ from their ids, so a name or caption built from an id is caught.
const FIELDS: ModelsPayload = {
  backends: [
    { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
    { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
  ],
  claudeFamilies: [{ family: 'sonnet', label: 'Sonnet', default: 'claude-sonnet-5-5', versions: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] }],
  tiers: [{ tier: 'fast', label: 'Quick' }, { tier: 'frontier', label: 'Edge' }],
  tierBackend: { fast: { backend: 'claude', model: 'claude-sonnet-5-5' }, frontier: { backend: 'ollama', model: 'mine:v1' } },
  tierEffort: {},
  customModels: [{ label: 'Mine', model: 'mine:v1', backend: 'ollama', contextWindow: 256000 }],
  ollamaCloudModels: [],
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  enabledTiers: { fast: true, frontier: true },
  defaultSpawnTier: 'fast',
  roles: [{ role: 'conductor', label: 'Lead', builtin: true }, { role: 'tester' }],
  roleBackend: { conductor: { kind: 'tier', tier: 'fast', model: '' }, tester: { backend: 'ollama', model: 'mine:v1' } },
  roleEffort: {},
  conductorCompactWindow: { enabled: false, value: 300 },
};

// The payload label each row's controls name, by the row's data-tier / data-role.
const ROW: Record<string, string> = { fast: 'Quick', frontier: 'Edge', conductor: 'Lead', tester: 'tester' };
// Each row's select count: 3 per tier, 2 on a tier-bound role, 4 on a Custom one.
const SELECTS: Record<string, number> = { fast: 3, frontier: 3, conductor: 2, tester: 4 };
// The two halves of each row's pair, by value: the bound model, then the effort it shows.
const PAIR: Record<string, [string, string] | null> = {
  fast: ['claude-sonnet-5-5', 'high'],
  frontier: ['mine:v1', 'high'],
  tester: ['mine:v1', 'inherit'],
  conductor: null,
};

beforeEach(() => {
  mockFetch({ 'GET /api/settings/spawn': () => ({}) });
  modelsSettingsStore.set({ data: FIELDS, error: null, status: null });
  render(<TooltipProvider><ModelsSection /></TooltipProvider>);
});
afterEach(() => {
  modelsSettingsStore.set({ data: null, error: null, status: null });
  vi.unstubAllGlobals();
});

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="tier-list"] > li, [data-testid="role-list"] > li')];
const keyOf = (li: Element) => li.getAttribute('data-tier') ?? li.getAttribute('data-role') ?? '';
const rowOf = (key: string) => rows().find((li) => keyOf(li) === key)!;
const selects = () => rows().flatMap((li) => [...li.querySelectorAll('select')]);
const nameOf = (e: Element) => e.getAttribute('aria-label') ?? '';
const captionOf = (s: HTMLSelectElement) => (s.id ? document.querySelector(`label[for="${s.id}"]`) : null);

describe('Models → field labels', () => {
  // Every row select is the target of its own non-empty label[for], in its own row, and its accessible name contains that caption.
  it('every tier and role select has its own caption, a word its name contains', () => {
    const all = selects();
    // Positive control: every row renders all of its selects.
    expect(rows().map((li) => [keyOf(li), li.querySelectorAll('select').length]).sort(), 'selects per row').toEqual(Object.entries(SELECTS).sort());
    for (const s of all) {
      const cap = captionOf(s);
      const text = cap?.textContent?.trim() ?? '';
      expect(text, `${nameOf(s)}: its caption`).not.toBe('');
      expect(nameOf(s).toLowerCase(), `${nameOf(s)} vs its caption`).toContain(text.toLowerCase());
      expect(cap!.closest('li') === s.closest('li'), `${nameOf(s)}: its caption sits in its own row`).toBe(true);
    }
  });

  // The switch and the radio are named, row-specifically, from the payload's tier label; the radio's visible caption is contained in its name.
  it('the tier enable switch and default radio each name their row, and the radio keeps a caption its name contains', () => {
    for (const key of ['fast', 'frontier']) {
      const li = rowOf(key);
      const sw = li.querySelector('[role="switch"]');
      const radio = li.querySelector('input[type="radio"]');
      expect(nameOf(sw!), `${key}: the switch`).toContain(ROW[key]);
      expect(nameOf(radio!), `${key}: the radio`).toContain(ROW[key]);
      const cap = radio!.closest('label')?.textContent?.trim() ?? '';
      expect(cap, `${key}: the radio's caption`).not.toBe('');
      expect(nameOf(radio!).toLowerCase(), `${key}: the radio's name vs its caption`).toContain(cap.toLowerCase());
    }
  });

  // Each binding select's name carries its row's label and no two selects share a name, so identical captions never leave two indistinguishable.
  it('the backend, model and binding selects carry a row-specific name, not just a shared caption', () => {
    const names = selects().map(nameOf);
    expect(new Set(names).size, 'distinct names').toBe(names.length);
    for (const li of rows()) {
      for (const s of li.querySelectorAll('select')) expect(nameOf(s), `${keyOf(li)}: ${nameOf(s)}`).toContain(ROW[keyOf(li)]);
    }
  });

  // A caption wrapper never becomes a row boundary: each row holds exactly its own selects, switch and radio.
  it('every control sits inside its own row, and each row holds all of its controls', () => {
    for (const li of rows()) {
      const key = keyOf(li);
      expect(li.querySelectorAll('select').length, `${key}: selects`).toBe(SELECTS[key]);
      for (const c of li.querySelectorAll('select, [role="switch"], input[type="radio"]')) expect(c.closest('li') === li, `${key}: ${nameOf(c)}`).toBe(true);
    }
    expect(rowOf('fast').querySelectorAll('[role="switch"], input[type="radio"]').length).toBe(2);
    expect(rowOf('frontier').querySelectorAll('[role="switch"], input[type="radio"]').length).toBe(2);
  });

  // A pair holds exactly [the bound model's select, the effort select] wherever a row has a model; a tier-bound role has none.
  it('model and effort share one pair, and only where both exist', () => {
    for (const [key, want] of Object.entries(PAIR)) {
      const li = rowOf(key);
      // Positive control: the row renders an effort select showing the effort its pair (or the lone field) should hold.
      const effort = want ? want[1] : 'inherit';
      expect([...li.querySelectorAll('select')].some((s) => s.value === effort), `${key}: effort select`).toBe(true);
      const pairs = [...li.querySelectorAll('[data-field-pair]')].map((p) => [...p.querySelectorAll('select')].map((s) => s.value));
      expect(pairs, `${key}: pairs`).toEqual(want ? [want] : []);
    }
  });

  // There is one non-empty caption per select, and the switch, named by the tier label shown beside it, has none.
  it('no caption is emitted empty, and the enable switch, named by the tier beside it, has none', () => {
    const all = selects();
    expect(all, 'row selects').toHaveLength(Object.values(SELECTS).reduce((a, b) => a + b, 0));
    const caps = rows().flatMap((li) => [...li.querySelectorAll('label[for]')]);
    expect(caps, 'one caption per select').toHaveLength(all.length);
    for (const c of caps) expect(c.textContent?.trim(), 'a caption').not.toBe('');
    for (const key of ['fast', 'frontier']) {
      const li = rowOf(key);
      const sw = li.querySelector('[role="switch"]')!;
      expect([...li.querySelectorAll('span')].some((s) => s.textContent === ROW[key]), `${key}: its label shows beside the switch`).toBe(true);
      expect(sw.id === '' || document.querySelector(`label[for="${sw.id}"]`) === null, `${key}: the switch has no caption`).toBe(true);
    }
  });
});
