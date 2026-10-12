import { afterEach, describe, expect, it } from 'vitest';
import { openerOf } from './modalFocus';

afterEach(() => { document.body.innerHTML = ''; });

describe('openerOf', () => {
  it("a Radix menu item's opener is its menu's trigger; any other element is its own opener", () => {
    document.body.innerHTML = `
      <button id="trigger">⋮</button>
      <div role="menu" aria-labelledby="trigger"><div role="menuitem" id="item">Statistics</div></div>
      <div role="menu"><div role="menuitem" id="orphan">Unlabelled</div></div>
      <button id="plain">Open sidebar</button>`;
    const byId = (id: string) => document.getElementById(id);
    expect(openerOf(byId('item'))).toBe(byId('trigger'));
    expect(openerOf(byId('orphan')), 'a menu naming no trigger has no opener').toBeNull();
    expect(openerOf(byId('plain'))).toBe(byId('plain'));
    expect(openerOf(document.body), 'nothing focused').toBeNull();
    expect(openerOf(null)).toBeNull();
  });
});
