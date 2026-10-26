import { describe, expect, it } from 'vitest';
import { CI, CI_LABEL, C1, C1_LABEL, C2, C2_LABEL, fleet } from '@/test/workerFleet';
import { isBackToOwnerKey, ownerSendBlock, workerOwnerOf } from './workerOwner';

const conductRows = [{ sessionId: CI, firstPrompt: CI_LABEL, lastActivity: 5 }] as any[];
const ownerOf = (f: ReturnType<typeof fleet>, w: any) => workerOwnerOf(w, { instances: Object.values(f), conductRows });

describe('workerOwnerOf', () => {
  it('conductor and hand-spawned resolve to none', () => {
    const f = fleet();
    expect(ownerOf(f, f.w1).kind).toBe('owned'); // premise: the same context does resolve a worker
    expect(ownerOf(f, f.c1)).toEqual({ kind: 'none' });
    expect(ownerOf(f, f.h)).toEqual({ kind: 'none' });
  });

  // Invariant: a session in the conductor project is never a worker, even when conducted with a known owner (a section lead).
  it('a conducted session in the conductor project resolves to none even with an owner', () => {
    const f = fleet();
    const lead = { ...f.c2, conducted: true, ownerSessionId: C1 };
    expect(ownerOf(f, { ...lead, project: 'other-project' }).kind).toBe('owned'); // premise: only the project differs
    expect(ownerOf(f, lead)).toEqual({ kind: 'none' });
  });

  it('a live conducted worker resolves its owner\'s label and instance; C1 and C2 workers resolve differently', () => {
    const f = fleet();
    const o1 = ownerOf(f, f.w1);
    const o2 = ownerOf(f, f.w2);
    expect(o1).toMatchObject({ kind: 'owned', sessionId: C1, label: C1_LABEL });
    expect(o2).toMatchObject({ kind: 'owned', sessionId: C2, label: C2_LABEL });
    expect((o1 as any).instance?.id).toBe(f.c1.id);
    expect((o2 as any).instance?.id).toBe(f.c2.id);
  });

  it('ownerSessionId null resolves to unknown', () => {
    const f = fleet();
    expect(ownerOf(f, f.wu)).toEqual({ kind: 'unknown' });
  });

  it('owner instance listed → select target; inactive listed conductor → resume-conductor; absent owner → no target', () => {
    const f = fleet();
    expect(ownerOf(f, f.w1)).toMatchObject({ target: { kind: 'select', instanceId: f.c1.id } });
    expect(ownerOf(f, f.wi)).toMatchObject({ kind: 'owned', label: CI_LABEL, instance: null, target: { kind: 'resume-conductor' } });
    expect(ownerOf(f, f.wa)).toMatchObject({ kind: 'owned', instance: null, target: null });
  });
});

describe('ownerSendBlock', () => {
  const owned = (instance: any) => ({ kind: 'owned' as const, sessionId: C1, label: 'Alpha', instance, target: null });
  it('idle and turn owner → null; no instance / spawning / modelSwitch / overageStoppedUnarmed → a reason', () => {
    const f = fleet();
    expect(ownerSendBlock(owned(f.c1))).toBeNull();
    expect(ownerSendBlock(owned({ ...f.c1, status: 'turn' }))).toBeNull();
    const reasons = [owned(null), owned({ ...f.c1, status: 'spawning' }), owned({ ...f.c1, modelSwitch: { to: 'x' } }), owned({ ...f.c1, overageStoppedUnarmed: true }), owned({ ...f.c1, status: 'exited' }), owned({ ...f.c1, status: 'crashed' })].map(ownerSendBlock);
    for (const reason of reasons) {
      expect(typeof reason).toBe('string');
      expect(reason).toContain('Alpha');
    }
    // No instance, exited and crashed all read as not running; spawning, switching and overage each differ.
    expect(reasons[0]).toBe(reasons[4]);
    expect(reasons[4]).toBe(reasons[5]);
    expect(new Set(reasons).size).toBe(4);
  });
});

describe('isBackToOwnerKey', () => {
  const key = (init: KeyboardEventInit = {}, target?: Element) => {
    const e = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true, ...init });
    if (target) Object.defineProperty(e, 'target', { value: target });
    return e;
  };
  it('Alt+ArrowUp only', () => {
    expect(isBackToOwnerKey(key())).toBe(true);
    expect(isBackToOwnerKey(key({ altKey: false }))).toBe(false);
    expect(isBackToOwnerKey(key({ key: 'ArrowDown' }))).toBe(false);
  });
  it('Shift/Ctrl/Meta, repeat, composing and defaultPrevented are ignored', () => {
    expect(isBackToOwnerKey(key())).toBe(true); // premise: the same event passes unmodified
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }]) {
      expect(isBackToOwnerKey(key(init))).toBe(false);
    }
    const prevented = key();
    prevented.preventDefault();
    expect(isBackToOwnerKey(prevented)).toBe(false);
  });
  it('a target inside menu/dialog/alertdialog/listbox/combobox or a select is ignored', () => {
    for (const html of ['<div role="menu"><button id="t"></button></div>', '<div role="dialog"><textarea id="t"></textarea></div>', '<div role="alertdialog"><button id="t"></button></div>',
      '<div role="listbox"><div id="t"></div></div>', '<div role="combobox" id="t"></div>', '<select id="t"></select>']) {
      document.body.innerHTML = html;
      expect(isBackToOwnerKey(key({}, document.getElementById('t')!))).toBe(false);
    }
    document.body.innerHTML = '<textarea id="t"></textarea>';
    expect(isBackToOwnerKey(key({}, document.getElementById('t')!))).toBe(true);
    document.body.innerHTML = '';
  });
});
