// Conduct: spawn a conductor straight away (no dialog) — a temp session in the
// hidden `.conduct` project, code mode, on the Conductor role. The server
// resolves the role's current model and default effort.
import { apiFetch } from '@/lib/core/http.js';
import { createStore } from '@/state/createStore';
import { refreshInstances, refreshProjects, selectInstance } from '@/app/controller';
import { toast } from '@/ui/feedback';

export const conductStore = createStore({ starting: false });

export async function startConducting() {
  if (conductStore.get().starting) return;
  conductStore.set({ starting: true });
  try {
    const r = await fetch('/api/projects/.conduct/ensure', { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `ensure failed (${r.status})`);
    }
    const inst = await apiFetch('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' }),
    });
    await refreshProjects();
    await refreshInstances();
    selectInstance(inst.id, { userGesture: true });
  } catch (e: any) {
    toast.error('The conductor failed to start', e.message);
  } finally {
    conductStore.set({ starting: false });
  }
}
