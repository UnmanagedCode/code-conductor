// Light / dark / system theme. The choice persists per browser; "system" follows
// prefers-color-scheme live. index.html applies the stored choice before first
// paint so there is no flash.
import { createStore } from '@/state/createStore';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'code-conductor:theme';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const mq = matchMedia('(prefers-color-scheme: dark)');
const resolve = (c: ThemeChoice): 'light' | 'dark' => (c === 'system' ? (mq.matches ? 'dark' : 'light') : c);

export const themeStore = createStore({ choice: read(), resolved: resolve(read()) });

function apply() {
  const resolved = resolve(themeStore.get().choice);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#1c1917' : '#fcfbfa');
  if (resolved !== themeStore.get().resolved) themeStore.set({ resolved });
}

mq.addEventListener('change', apply);
apply();

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* storage unavailable */ }
  themeStore.set({ choice });
  apply();
}

export function toggleTheme() {
  setTheme(themeStore.get().resolved === 'dark' ? 'light' : 'dark');
}
