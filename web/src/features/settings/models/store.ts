// The /api/settings/models payload, shared by Models, Backends and Account
// (overage). Every save answers the refreshed payload, which also refreshes
// the app-wide model catalog (applyModels).
import { createStore } from '@/state/createStore';
import { applyModels } from '@/app/models';
import { json, post, errText } from '../api';
import type { ModelsPayload } from './logic';

export const modelsSettingsStore = createStore<{ data: ModelsPayload | null; error: string | null; status: string | null }>({
  data: null, error: null, status: null,
});

export async function loadModelsSettings() {
  try {
    modelsSettingsStore.set({ data: await json<ModelsPayload>('/api/settings/models'), error: null });
  } catch (e) {
    modelsSettingsStore.set({ error: `Failed to load models: ${errText(e)}` });
  }
}

/** Show a fresh payload everywhere. `refreshCatalog` false for prefs nothing else reads. */
export function applyModelsPayload(data: ModelsPayload, refreshCatalog = true) {
  modelsSettingsStore.set({ data, error: null, status: null });
  if (refreshCatalog) applyModels(data);
}

/** POST /api/settings/models/prefs; a failure becomes the panel status (`what failed: …`). */
export async function savePrefs(body: Record<string, unknown>, what = 'Update', refreshCatalog = true) {
  try {
    applyModelsPayload(await post<ModelsPayload>('/api/settings/models/prefs', body), refreshCatalog);
    return true;
  } catch (e) {
    modelsSettingsStore.set({ status: `${what} failed: ${errText(e)}` });
    return false;
  }
}

export const setModelsStatus = (status: string | null) => modelsSettingsStore.set({ status });
