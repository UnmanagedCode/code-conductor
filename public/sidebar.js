import { el } from './blocks.js';

export class Sidebar {
  constructor({ rootList, onSelectInstance, onCreateInstanceClick, onRemoveWorktree, onDeleteProject }) {
    this.list = rootList;
    this.onSelectInstance = onSelectInstance;
    this.onCreateInstanceClick = onCreateInstanceClick;
    this.onRemoveWorktree = onRemoveWorktree;
    this.onDeleteProject = onDeleteProject;
    this.projects = [];
    this.instances = [];
    this.activeInstanceId = null;
    // Track which worktree groups have been expanded so a re-render
    // doesn't slam them shut every time the instance list changes.
    this.expandedWorktrees = new Set(); // key = projectName
  }

  setProjects(projects) { this.projects = projects; this.render(); }
  setInstances(instances) { this.instances = instances; this.render(); }
  setActive(id) { this.activeInstanceId = id; this.render(); }

  _instanceRow(inst) {
    const sessionLabel = (inst.sessionId ?? inst.id).slice(0, 8);
    return el('div', {
      class: 'instance-row' + (inst.id === this.activeInstanceId ? ' active' : ''),
      onclick: () => this.onSelectInstance(inst.id),
    },
      el('span', { class: `dot ${inst.status}`, title: inst.status }),
      el('span', { class: 'instance-name', title: inst.sessionId ?? inst.id }, sessionLabel),
    );
  }

  _worktreeNode(project, wt, attachedInstances) {
    const head = el('div', { class: 'worktree-row' },
      el('span', { class: 'worktree-name', title: `${wt.branch}\nfrom ${wt.baseBranch} @ ${wt.baseSha?.slice(0, 12) ?? '?'}` },
        wt.worktreeName.replace(`${project.name}_worktree_`, ''),
      ),
      el('span', { class: 'worktree-base' }, `← ${wt.baseBranch}`),
      el('button', {
        class: 'wt-spawn', title: 'spawn agent into this worktree',
        onclick: (e) => { e.stopPropagation(); this.onCreateInstanceClick(project.name, { worktreeName: wt.worktreeName }); },
      }, '+'),
      el('button', {
        class: 'wt-remove', title: 'remove worktree',
        onclick: (e) => { e.stopPropagation(); this.onRemoveWorktree(project.name, wt.worktreeName); },
      }, '×'),
    );
    const instUl = el('ul', { class: 'instance-list' });
    for (const inst of attachedInstances) {
      instUl.appendChild(el('li', {}, this._instanceRow(inst)));
    }
    return el('li', { class: 'worktree-item' }, head, instUl);
  }

  render() {
    // Bucket instances by (project, worktree?) so worktree-attached
    // instances render under their worktree row instead of the project's
    // top-level list.
    const directByProject = new Map();
    const byWorktree = new Map();
    for (const i of this.instances) {
      if (i.worktree?.worktreeName) {
        const key = `${i.project}:${i.worktree.worktreeName}`;
        let arr = byWorktree.get(key);
        if (!arr) { arr = []; byWorktree.set(key, arr); }
        arr.push(i);
      } else {
        let arr = directByProject.get(i.project);
        if (!arr) { arr = []; directByProject.set(i.project, arr); }
        arr.push(i);
      }
    }

    this.list.innerHTML = '';
    if (this.projects.length === 0) {
      this.list.appendChild(el('li', { class: 'project-row' },
        el('span', { class: 'project-name' }, 'no projects yet')));
      return;
    }

    for (const p of this.projects) {
      const directs = directByProject.get(p.name) ?? [];
      const worktrees = Array.isArray(p.worktrees) ? p.worktrees : [];
      const li = el('li', {});
      li.appendChild(el('div', { class: 'project-row' },
        el('span', { class: 'project-name' }, p.name),
        el('button', {
          class: 'add-instance', title: 'new instance',
          onclick: () => this.onCreateInstanceClick(p.name),
        }, '+'),
        el('button', {
          class: 'delete-project', title: 'delete project',
          onclick: (e) => { e.stopPropagation(); this.onDeleteProject(p); },
        }, '×'),
      ));

      const ul = el('ul', { class: 'instance-list' });
      for (const inst of directs) ul.appendChild(el('li', {}, this._instanceRow(inst)));
      if (directs.length === 0 && worktrees.length === 0) {
        ul.appendChild(el('li', {},
          el('div', { class: 'instance-row', style: 'opacity:.5; cursor:default' },
            el('span', { class: 'instance-name' }, 'no instances'))));
      }
      li.appendChild(ul);

      if (worktrees.length > 0) {
        const det = el('details', { class: 'worktree-group' });
        if (this.expandedWorktrees.has(p.name)) det.setAttribute('open', '');
        det.addEventListener('toggle', () => {
          if (det.open) this.expandedWorktrees.add(p.name);
          else this.expandedWorktrees.delete(p.name);
        });
        det.appendChild(el('summary', { class: 'worktree-summary' },
          `Worktrees (${worktrees.length})`));
        const wtUl = el('ul', { class: 'worktree-list' });
        for (const wt of worktrees) {
          const key = `${p.name}:${wt.worktreeName}`;
          const attached = byWorktree.get(key) ?? [];
          wtUl.appendChild(this._worktreeNode(p, wt, attached));
        }
        det.appendChild(wtUl);
        li.appendChild(det);
      }

      this.list.appendChild(li);
    }
  }
}
