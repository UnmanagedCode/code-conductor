// Sidebar app switcher — the `<h1>CodeConductor</h1>` becomes a dropdown
// when at least one enabled plugin contributes a frontend. Selecting a
// plugin enters its iframe view via the `#plugin/<id>/` hash space (owned
// by pluginView.js); selecting Conductor while inside a plugin view goes
// history.back() so the plugin entry costs exactly one history step.
// With zero plugins the plain <h1> stays — no visual change.

const CONDUCTOR = 'conductor';

export function installAppSwitcher() {
  const select = document.getElementById('app-switcher-select');
  const title = document.querySelector('#app-switcher h1');
  if (!select || !title) return { refresh() {} };

  let plugins = [];

  function currentPluginId() {
    const m = /^#plugin\/([a-z][a-z0-9-]*)/.exec(location.hash);
    return m ? m[1] : null;
  }

  function render() {
    const apps = plugins.filter(p => p.enabled && p.hasFrontend);
    if (apps.length === 0) {
      select.hidden = true;
      title.hidden = false;
      return;
    }
    select.innerHTML = '';
    const home = document.createElement('option');
    home.value = CONDUCTOR;
    home.textContent = 'Conductor';
    select.appendChild(home);
    for (const p of apps) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.navLabel || p.name;
      select.appendChild(opt);
    }
    select.hidden = false;
    title.hidden = true;
    sync();
  }

  // Reflect the active view in the dropdown (hash is the source of truth).
  function sync() {
    if (select.hidden) return;
    const id = currentPluginId();
    select.value = id && plugins.some(p => p.id === id) ? id : CONDUCTOR;
  }

  select.addEventListener('change', () => {
    const v = select.value;
    if (v === CONDUCTOR) {
      if (currentPluginId()) history.back();
    } else {
      location.hash = `#plugin/${v}/`;
    }
  });
  window.addEventListener('hashchange', sync);

  async function refresh() {
    try {
      const r = await fetch('/api/plugins', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      plugins = await r.json();
    } catch {
      plugins = [];
    }
    render();
  }

  refresh();
  return { refresh };
}
