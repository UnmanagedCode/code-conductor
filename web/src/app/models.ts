// The client-side model catalog (lib/core/models.js caches it); `modelsSignal`
// tells React when it was reloaded or edited in Settings → Models.
import { applyModelsPayload, loadModelVersions } from '@shared/models';
import { createSignal } from '@/state/createStore';

export const modelsSignal = createSignal();

export async function loadModels() {
  await loadModelVersions();
  modelsSignal.bump();
}

/** Settings → Models saved: apply the fresh payload everywhere. */
export function applyModels(data: unknown) {
  applyModelsPayload(data);
  modelsSignal.bump();
}
