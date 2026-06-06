// Sub-agent panel: shows workers spawned by the active conductor instance
// via MCP spawn_instance, using the same visual treatment as the task panel.
// Populated from state.instances (callerInstanceId field) — no new WS type;
// status updates arrive via the existing `instances` hint → refreshInstances().

export class SubagentPanel {
  constructor(host) {
    this.host = host;
    // Callback(instanceId) invoked when the user taps a worker card.
    this.onNavigate = null;
  }

  setInstances(instances, activeId) {
    const workers = activeId
      ? instances.filter(i => i.callerInstanceId === activeId)
      : [];
    this._render(workers);
  }

  _render(workers) {
    if (workers.length === 0) {
      this.host.hidden = true;
      this.host.replaceChildren();
      return;
    }

    const head = document.createElement('div');
    head.className = 'task-panel-head';
    head.textContent = `Sub-agents · ${workers.length}`;

    const ul = document.createElement('ul');
    ul.className = 'task-panel-list';

    for (const w of workers) {
      const li = document.createElement('li');
      li.className = `task-row ${this._rowClass(w.status)}`;

      const marker = document.createElement('span');
      marker.className = 'task-marker';
      marker.textContent = this._marker(w.status);

      const text = document.createElement('span');
      text.className = 'task-text';
      text.textContent = this._label(w);

      li.append(marker, text);

      li.addEventListener('click', () => this.onNavigate?.(w.id));

      ul.appendChild(li);
    }

    this.host.hidden = false;
    this.host.replaceChildren(head, ul);
  }

  _label(inst) {
    const raw = (inst.title || inst.firstPrompt || '').replace(/\s+/g, ' ').trim();
    if (raw) return raw.slice(0, 60) + (raw.length > 60 ? '…' : '');
    return `${inst.project} · ${inst.id.slice(0, 8)}`;
  }

  _rowClass(status) {
    switch (status) {
      case 'turn':     return 'task-in_progress';
      case 'idle':     return 'task-in_progress subagent-idle';
      case 'exited':   return 'task-completed';
      case 'crashed':  return 'subagent-crashed';
      default:         return 'task-pending'; // spawning, unknown
    }
  }

  _marker(status) {
    switch (status) {
      case 'turn':    return '▶';
      case 'idle':    return '●';
      case 'exited':  return '✓';
      case 'crashed': return '✗';
      default:        return '○'; // spawning
    }
  }
}
