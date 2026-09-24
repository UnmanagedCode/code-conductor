// Sub-agent panel: shows workers spawned by the active conductor instance
// via MCP spawn_instance, using the same visual treatment as the task panel.
// Populated from state.instances (callerInstanceId field, plus playbook/stage
// for a playbook-bound worker) — no new WS type; status and binding updates
// both arrive via the existing `instances` hint → refreshInstances() (the hint
// also fires on a ledger spawn/transition, not just a status flip).

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
      li.className = `task-row ${this._rowClass(w.displayStatus)}`;

      const marker = document.createElement('span');
      marker.className = 'task-marker';
      marker.textContent = this._marker(w.displayStatus);

      const text = document.createElement('span');
      text.className = 'task-text';
      text.textContent = this._label(w);

      li.append(marker, text);
      const playbookLabel = this._playbookLabel(w);
      if (playbookLabel) li.append(playbookLabel);

      li.addEventListener('click', () => this.onNavigate?.(w.id));

      ul.appendChild(li);
    }

    this.host.hidden = false;
    this.host.replaceChildren(head, ul);
  }

  // null for a worker with no playbook binding — no element at all, not a
  // hidden/empty one, so an unbound worker's row stays byte-identical to a
  // build with no playbook feature.
  _playbookLabel(w) {
    if (!w.playbook || !w.stage) return null;
    const span = document.createElement('span');
    span.className = 'subagent-playbook';
    span.textContent = `${w.playbook} · ${w.stage}`;
    span.title = `playbook ${w.playbook}, stage ${w.stage}`;
    return span;
  }

  _label(inst) {
    const raw = (inst.title || inst.firstPrompt || '').replace(/\s+/g, ' ').trim();
    if (raw) return raw.slice(0, 60) + (raw.length > 60 ? '…' : '');
    return `${inst.project} · ${inst.id.slice(0, 8)}`;
  }

  _rowClass(status) {
    switch (status) {
      case 'turn':     return 'task-in_progress';
      case 'running':  return 'task-in_progress'; // idle but a background subagent is still working
      case 'idle':     return 'task-in_progress subagent-idle';
      case 'exited':   return 'task-completed';
      case 'crashed':  return 'subagent-crashed';
      default:         return 'task-pending'; // spawning, unknown
    }
  }

  _marker(status) {
    switch (status) {
      case 'turn':    return '▶';
      case 'running': return '▶'; // idle but a background subagent is still working
      case 'idle':    return '●';
      case 'exited':  return '✓';
      case 'crashed': return '✗';
      default:        return '○'; // spawning
    }
  }
}
