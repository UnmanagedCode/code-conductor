import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  adoptInstance: vi.fn(),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/ui/feedback', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { startConducting } from './conduct';
import { adoptInstance, refreshProjects, selectInstance } from '@/app/controller';
import { toast } from '@/ui/feedback';
import { routeFetch } from '@/test/routeFetch';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Conduct', () => {
  it('Conduct POSTs only the conductor body (a pristine temp conductor in code mode, no effort or tier), adopts it and selects it', async () => {
    const calls = routeFetch({ 'POST /api/instances': () => ({ json: { id: 'i9', sessionId: 's9' } }) });
    await startConducting();
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/instances']);
    expect(writes[0].body).toEqual({ project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions', pristine: true });
    expect(adoptInstance).toHaveBeenCalledWith({ id: 'i9', sessionId: 's9' });
    expect(selectInstance).toHaveBeenCalledWith('i9', { userGesture: true, gesture: expect.any(Number) });
  });

  it('a refused create names its status in the toast, and adopts and selects nothing', async () => {
    routeFetch({ 'POST /api/instances': () => ({ status: 502, json: {} }) });
    await startConducting();
    expect(toast.error).toHaveBeenCalledWith('The conductor failed to start', 'HTTP 502');
    expect(adoptInstance).not.toHaveBeenCalled();
    expect(selectInstance).not.toHaveBeenCalled();
  });

  it('a refused background projects refresh is logged, not toasted, and the conductor stays selected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(refreshProjects).mockRejectedValueOnce(new Error('projects down'));
    routeFetch({ 'POST /api/instances': () => ({ json: { id: 'i9', sessionId: 's9' } }) });
    await startConducting();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledExactlyOnceWith('refreshProjects after Conduct failed:', expect.objectContaining({ message: 'projects down' })));
    expect(toast.error).not.toHaveBeenCalled();
    expect(selectInstance).toHaveBeenCalledWith('i9', { userGesture: true, gesture: expect.any(Number) });
  });
});
