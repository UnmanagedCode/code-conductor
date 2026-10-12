import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { toast as sonnerToast } from 'sonner';
import { installToastFocus } from '@/ui/toastFocus';
import { ToastHost, toast } from '@/ui/feedback';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// A page, then sonner's markup: <section> → list → toast → Close toast. `sonner` stands for sonner's
// list handler (React's root listener hands it every focusin whose target is inside the list), and
// `doc` for the document-level listeners (Radix's focus-outside and focus traps).
function fixture() {
  teardown();
  document.body.innerHTML = `
    <button id="page">page</button><button id="other">other</button>
    <div id="root"><section tabindex="-1"><ol data-sonner-toaster tabindex="-1">
      <li data-sonner-toast tabindex="0"><button id="close">Close toast</button></li>
    </ol></section></div>`;
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const [page, other, root, section, list, item, close] = ['#page', '#other', '#root', 'section', 'ol', 'li', '#close'].map((s) => $(s));
  const sonner: FocusEvent[] = [];
  const doc: FocusEvent[] = [];
  const listeners = new AbortController();
  root.addEventListener('focusin', (e) => { if (list.contains(e.target as Node)) sonner.push(e); }, { signal: listeners.signal });
  document.addEventListener('focusin', (e) => doc.push(e), { signal: listeners.signal });
  const uninstall = installToastFocus(section);
  teardown = () => { uninstall(); listeners.abort(); document.body.innerHTML = ''; };
  return { page, other, section, list, item, close, sonner, doc };
}
let teardown = () => {};
afterEach(() => teardown());

/** A dismissal as Chromium runs it (measured): the focused element blurs with no relatedTarget, then its toast leaves the DOM. */
function dismiss(focused: HTMLElement, toastEl: HTMLElement) {
  focused.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  toastEl.remove();
}
/** Lets the mutation observer and the focusout check run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('installToastFocus', () => {
  it('hides a Tab or click entry from sonner\'s list and re-dispatches it to the document once, from the section, with its relatedTarget', () => {
    const f = fixture();
    f.page.focus();
    f.doc.length = 0;
    f.item.focus();
    // Invariant: sonner never sees the entry, so it records no element to send focus back to.
    expect(f.sonner).toHaveLength(0);
    // Invariant: document listeners see exactly one focusin per focus move, arriving at the section.
    expect(f.doc).toHaveLength(1);
    expect(f.doc[0].target === f.section).toBe(true);
    expect(f.doc[0].relatedTarget === f.page).toBe(true);
    f.close.focus();
    expect(f.sonner).toHaveLength(0);
    expect(f.doc).toHaveLength(2);
    expect(f.doc[1].relatedTarget === f.item).toBe(true);
  });

  it('lets Alt+T\'s focus of the list from the page reach sonner untouched, and hides one made from inside a toast', () => {
    const f = fixture();
    f.page.focus();
    f.doc.length = 0;
    f.list.focus();
    // Invariant: the hotkey's own entry is sonner's, delivered once, as the browser fired it.
    expect(f.sonner).toHaveLength(1);
    expect(f.sonner[0].relatedTarget === f.page).toBe(true);
    expect(f.doc).toHaveLength(1);
    expect(f.doc[0].target === f.list).toBe(true);
    // Invariant: Alt+T pressed inside a toast is hidden, or sonner would send focus back into the toast.
    f.item.focus();
    f.list.focus();
    expect(f.sonner).toHaveLength(1);
  });

  it('returns focus to the page element a Tab entry came from when a dismissal removes the focused toast element', async () => {
    const f = fixture();
    f.page.focus();
    f.item.focus();
    f.close.focus();
    dismiss(f.close, f.item);
    await settle();
    expect(document.activeElement === f.page).toBe(true);
  });

  it('returns focus to the element that held it before a pointer Close', async () => {
    const f = fixture();
    f.other.focus();
    // A pointer press on Close toast focuses it straight from the page element that held focus.
    f.close.focus();
    dismiss(f.close, f.item);
    await settle();
    expect(document.activeElement === f.other).toBe(true);
  });

  it('leaves focus alone when something else took it before the dismissal settled', async () => {
    const f = fixture();
    f.page.focus();
    f.item.focus();
    dismiss(f.item, f.item);
    f.other.focus();
    await settle();
    expect(document.activeElement === f.other).toBe(true);
  });

  it('leaves focus alone when the element focus came from is gone or no longer focusable', async () => {
    const f = fixture();
    f.page.focus();
    f.item.focus();
    f.page.remove();
    dismiss(f.item, f.item);
    await settle();
    expect(document.activeElement === document.body).toBe(true);

    const g = fixture();
    g.page.focus();
    g.item.focus();
    (g.page as HTMLButtonElement).disabled = true;
    dismiss(g.item, g.item);
    await settle();
    expect(document.activeElement === g.page).toBe(false);
  });

  it('never pulls focus back for a toast that leaves after focus moved on to the page', async () => {
    const f = fixture();
    f.page.focus();
    f.item.focus();
    f.other.focus();
    f.item.remove();
    await settle();
    expect(document.activeElement === f.other).toBe(true);
  });

  it('never pulls focus back for a toast that leaves after Tab took focus out of the document', async () => {
    const f = fixture();
    f.page.focus();
    f.close.focus();
    // Tab past the toaster, the page's last stop: focus leaves the document, the element stays.
    f.close.blur();
    await settle();
    f.item.remove();
    await settle();
    expect(document.activeElement === document.body).toBe(true);
  });

  it('keeps the element to return to across a window switch that leaves focus on the toast', async () => {
    const f = fixture();
    f.page.focus();
    f.close.focus();
    f.close.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await settle();
    expect(document.activeElement === f.close).toBe(true);
    dismiss(f.close, f.item);
    await settle();
    expect(document.activeElement === f.page).toBe(true);
  });
});

describe('ToastHost', () => {
  afterEach(() => { act(() => { sonnerToast.dismiss(); }); });

  it('closes an open non-modal popover when focus moves from it straight into a toast', async () => {
    render(
      <>
        <Popover defaultOpen>
          <PopoverTrigger>usage</PopoverTrigger>
          <PopoverContent>popover body</PopoverContent>
        </Popover>
        <ToastHost />
      </>,
    );
    act(() => { toast.info('Saved'); });
    const item = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-sonner-toast]');
      if (!el) throw new Error('no toast yet');
      return el;
    });
    expect(screen.queryByText('popover body'), 'fixture: the popover is open').not.toBeNull();
    // Invariant: the focusin hidden from sonner still reaches Radix's focus-outside, which closes the layer.
    act(() => { item.focus(); });
    await waitFor(() => expect(screen.queryByText('popover body')).toBeNull());
  });
});
