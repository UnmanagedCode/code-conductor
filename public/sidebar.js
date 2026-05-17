import { el } from './blocks.js';

export class Sidebar {
  constructor({ rootList, onSelectInstance, onCreateInstanceClick }) {
    this.list = rootList;
    this.onSelectInstance = onSelectInstance;
    this.onCreateInstanceClick = onCreateInstanceClick;
    this.projects = [];
    this.instances = [];
    this.activeInstanceId = null;
  }

  setProjects(projects) { this.projects = projects; this.render(); }
  setInstances(instances) { this.instances = instances; this.render(); }
  setActive(id) { this.activeInstanceId = id; this.render(); }

  render() {
    const byProject = new Map();
    for (const i of this.instances) {
      let arr = byProject.get(i.project);
      if (!arr) { arr = []; byProject.set(i.project, arr); }
      arr.push(i);
    }
    this.list.innerHTML = '';
    if (this.projects.length === 0) {
      this.list.appendChild(el('li', { class: 'project-row' },
        el('span', { class: 'project-name' }, 'no projects yet')));
      return;
    }
    for (const p of this.projects) {
      const insts = byProject.get(p.name) ?? [];
      const li = el('li', {});
      li.appendChild(el('div', { class: 'project-row' },
        el('span', { class: 'project-name' }, p.name),
        el('button', { class: 'add-instance', title: 'new instance',
          onclick: () => this.onCreateInstanceClick(p.name) }, '+'),
      ));
      const ul = el('ul', { class: 'instance-list' });
      for (const inst of insts) {
        const row = el('div', { class: 'instance-row' + (inst.id === this.activeInstanceId ? ' active' : ''),
          onclick: () => this.onSelectInstance(inst.id) },
          el('span', { class: `dot ${inst.status}`, title: inst.status }),
          el('span', { class: 'instance-name', title: inst.sessionId ?? inst.id },
            (inst.sessionId ?? inst.id).slice(0, 8)),
        );
        ul.appendChild(el('li', {}, row));
      }
      if (insts.length === 0) {
        ul.appendChild(el('li', {},
          el('div', { class: 'instance-row', style: 'opacity:.5; cursor:default' },
            el('span', { class: 'instance-name' }, 'no instances'))));
      }
      li.appendChild(ul);
      this.list.appendChild(li);
    }
  }
}
