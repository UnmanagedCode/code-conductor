// Conduct: spawn a conductor straight away (no dialog) — a temp session in the
// hidden `.conduct` project, code mode, on the Conductor role. The server
// resolves the role's current model and default effort.
import { apiFetch } from '@shared/http';
import { createStore } from '@/state/createStore';
import { refreshInstances, refreshProjects, selectInstance } from '@/app/controller';
import { beginGesture, gestureOvertaken } from '@/app/gestures';
import { toast } from '@/ui/feedback';
import type { Instance } from '@/state/types';

export const conductStore = createStore({ starting: false });

export async function startConducting() {
  if (conductStore.get().starting) return;
  conductStore.set({ starting: true });
  const gesture = beginGesture();
  try {
    const r = await fetch('/api/projects/.conduct/ensure', { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `ensure failed (${r.status})`);
    }
    const inst = await apiFetch<Instance>('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' }),
    });
    await refreshProjects();
    await refreshInstances();
    if (!gestureOvertaken(gesture)) selectInstance(inst.id, { userGesture: true, gesture });
  } catch (e: any) {
    toast.error('The conductor failed to start', e.message);
  } finally {
    conductStore.set({ starting: false });
  }
}
