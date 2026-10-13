import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { TOUCH_QUERY } from './textEntry';
import { openerOf } from './modalFocus';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

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

/** `(hover: none)` matches: a touch-primary device. */
const touch = () => vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q === TOUCH_QUERY, media: q }) as MediaQueryList);
const pointer = () => vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: false, media: q }) as MediaQueryList);

/** A dialog whose markup auto-focuses `field` (a text field or a button), opened by the second render. */
function Modal({ open, field }: { open: boolean; field: 'text' | 'button' }) {
  return (
    <>
      <button data-testid="outside">page</button>
      <Dialog open={open}>
        <DialogContent>
          <DialogTitle>Name it</DialogTitle>
          <DialogDescription>A dialog</DialogDescription>
          {field === 'text' ? <input aria-label="Name" autoFocus /> : <><button>Cancel</button><button autoFocus>Confirm</button></>}
        </DialogContent>
      </Dialog>
    </>
  );
}

async function open(field: 'text' | 'button') {
  const r = render(<Modal open={false} field={field} />);
  await act(async () => { r.rerender(<Modal open field={field} />); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

describe('the opening focus of Dialog and Sheet', () => {
  it('a dialog whose autofocus field took focus before the trap pulls focus back after it is taken outside', async () => {
    pointer();
    const dialog = await open('text');
    const field = dialog.querySelector('input')!;
    expect(document.activeElement, 'opens on its autofocus field').toBe(field);
    // A closing menu's item focusing its menu, or a closing drawer returning focus to its opener.
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="outside"]')!.focus(); });
    expect(document.activeElement, 'the trap pulls focus back to the field').toBe(field);
  });

  it('with a pointer the autofocus field keeps focus', async () => {
    pointer();
    const dialog = await open('text');
    expect(document.activeElement).toBe(dialog.querySelector('input'));
  });

  it('on touch a text-field target opens on the content, a button target keeps its button', async () => {
    touch();
    const dialog = await open('text');
    expect(document.activeElement, 'a text field: the dialog itself, so no soft keyboard pops').toBe(dialog);
    cleanup();
    const confirm = await open('button');
    expect(document.activeElement, 'a button: the button').toBe([...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Confirm'));
  });

  it("an autofocus that a still-trapped modal bounced out keeps its target: a confirm opened from the drawer opens on its confirm button", async () => {
    pointer();
    function Stack({ confirm }: { confirm: boolean }) {
      return (
        <>
          <Sheet open>
            <SheetContent><SheetTitle>Navigation</SheetTitle><button data-testid="row">Archive session</button></SheetContent>
          </Sheet>
          <Dialog open={confirm}>
            <DialogContent><DialogTitle>Archive?</DialogTitle><DialogDescription>Sure</DialogDescription><button>Cancel</button><button autoFocus>Archive</button></DialogContent>
          </Dialog>
        </>
      );
    }
    const r = render(<Stack confirm={false} />);
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="row"]')!.focus(); });
    await act(async () => { r.rerender(<Stack confirm />); });
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    expect(document.activeElement?.textContent).toBe('Archive');
  });
});
