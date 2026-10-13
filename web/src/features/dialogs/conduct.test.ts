import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/ui/feedback', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { startConducting } from './conduct';
import { selectInstance } from '@/app/controller';
import { toast } from '@/ui/feedback';
import { routeFetch } from '@/test/routeFetch';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Conduct', () => {
  it('Conduct ensures the .conduct project, then spawns a temp conductor in code mode with no effort or tier, and selects it', async () => {
    // Conduct ensures .conduct first, then POSTs exactly the conductor body (no effort, no tier), then selects the new id.
    const calls = routeFetch({ 'POST /api/instances': () => ({ json: { id: 'i9' } }) });
    await startConducting();
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/projects/.conduct/ensure', 'POST /api/instances']);
    expect(writes[1].body).toEqual({ project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' });
    expect(selectInstance).toHaveBeenCalledWith('i9', { userGesture: true, gesture: expect.any(Number) });
  });

  // A refused ensure with no `error` names its status, and nothing is spawned or selected.
  it('a refused ensure toasts HTTP 502 and spawns nothing', async () => {
    const calls = routeFetch({ 'POST /api/projects/.conduct/ensure': () => ({ status: 502, json: {} }) });
    await startConducting();
    expect(toast.error).toHaveBeenCalledWith('The conductor failed to start', 'HTTP 502');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/projects/.conduct/ensure']);
    expect(selectInstance).not.toHaveBeenCalled();
  });
});
