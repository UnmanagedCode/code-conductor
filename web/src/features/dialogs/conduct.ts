// Conduct: spawn a conductor straight away (no dialog) — a temp session in the
// hidden `.conduct` project, code mode, on the Conductor role. The server
// ensures the project and resolves the role's current model and default effort.
// The created instance is selected as soon as the create answers; the project
// lists refresh behind it.
import { apiFetch } from '@shared/http';
import { createStore } from '@/state/createStore';
import { adoptInstance, refreshProjects, selectInstance } from '@/app/controller';
import { beginGesture, gestureOvertaken } from '@/app/gestures';
import { toast } from '@/ui/feedback';
import type { Instance } from '@/state/types';

export const conductStore = createStore({ starting: false });

export async function startConducting() {
  if (conductStore.get().starting) return;
  conductStore.set({ starting: true });
  const gesture = beginGesture();
  try {
    const inst = await apiFetch<Instance>('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' }),
    });
    adoptInstance(inst);
    if (!gestureOvertaken(gesture)) selectInstance(inst.id, { userGesture: true, gesture });
    refreshProjects().catch((e) => console.warn('refreshProjects after Conduct failed:', e));
  } catch (e: any) {
    toast.error('The conductor failed to start', e.message);
  } finally {
    conductStore.set({ starting: false });
  }
}
