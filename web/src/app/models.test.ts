import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBackendModels } from '@shared/models';
import { loadModels, modelsSignal } from './models';

afterEach(() => { vi.unstubAllGlobals(); });

describe('models catalog', () => {
  it('loadModels fetches /api/settings/models without the cache, seeds the registered models and bumps modelsSignal', async () => {
    const ollama = [{ model: 'qwen3:8b', label: 'Qwen 8B' }, { model: 'llama3:70b', label: 'Llama 70B' }];
    const payload = {
      tiers: [{ tier: 'fast', label: 'Fast' }],
      backends: [{ id: 'claude', label: 'Claude' }, { id: 'ollama', label: 'Ollama' }],
      tierBackend: { fast: { backend: 'claude', model: 'claude-haiku-5-5' } },
      efforts: ['low', 'high'],
      backendModels: { ollama },
    };
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => payload }));
    vi.stubGlobal('fetch', fetch);
    expect(getBackendModels('ollama')).toEqual([]);
    const before = modelsSignal.version();
    await loadModels();
    expect(fetch.mock.calls).toEqual([['/api/settings/models', { cache: 'no-store' }]]);
    expect(getBackendModels('ollama')).toEqual(ollama);
    expect(modelsSignal.version() - before).toBe(1);
  });
});
