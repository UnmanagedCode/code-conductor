// Settings → Plugins tells the app switcher and the plugin frames that the
// catalog changed. `lastChange` names the action ({action, ids}) when it put
// new code under specific plugins (restart / version switch / update) — those
// resident frames must be evicted; other actions carry none.
import { createSignal, createStore } from '@/state/createStore';

export type PluginsChange = { action: 'restart' | 'version' | 'update'; ids: string[] } | undefined;

export const pluginsChangedSignal = createSignal();
export const pluginsChangeStore = createStore<{ lastChange: PluginsChange }>({ lastChange: undefined });

export function notifyPluginsChanged(change: PluginsChange) {
  pluginsChangeStore.set({ lastChange: change });
  pluginsChangedSignal.bump();
}
