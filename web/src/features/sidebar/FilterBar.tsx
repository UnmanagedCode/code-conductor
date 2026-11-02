import * as React from 'react';
import { SearchIcon, XIcon } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { setLens } from '@/app/ui';
import { cn } from '@/lib/utils';
import { isTextEntry } from '@/lib/textEntry';
import { filterOwner } from './derive';
import { setFilter, useSidebarUi } from './state';
import { OWNER_BAR, ownerStyle } from './rows';
import { clearQuery, consumeFilterFocus, requestFilterFocus, setQuery, useTextFilter } from './textFilterState';
import type { SidebarModel } from './useSidebarModel';

const INPUT_SELECTOR = '[data-filter-input]';

/** Passed as the drawer's `onEscapeKeyDown`: Radix listens on `document` in the capture phase, so without this an Esc in the input would close the drawer. */
export function keepFilterEscape(e: KeyboardEvent) {
  if (e.target instanceof Element && e.target.closest(INPUT_SELECTOR)) e.preventDefault();
}

/** The scope trigger's short label: All, Hand, or the conductor's own label (the menu items show the long ones). */
const shortLabel = (filter: string, options: SidebarModel['options']) =>
  filter === '' ? 'All' : filter === 'hand' ? 'Hand' : options.find((o) => o.value === filter)?.label ?? filter;
const fullLabel = (filter: string, options: SidebarModel['options']) => options.find((o) => o.value === filter)?.label ?? 'All sessions';

/** `/` takes the filter input from anywhere that is not itself text entry, switching to the Projects tab first. */
export function useSlashToFocus(active: boolean, rootRef: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTextEntry(document.activeElement)) return;
      const root = rootRef.current;
      const blocked = [...document.querySelectorAll('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')]
        .some((el) => !(root && (el.contains(root) || root.contains(el))));
      if (blocked) return;
      e.preventDefault();
      setLens('projects');
      requestFilterFocus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, rootRef]);
}

/** The Projects tab's filter row: the text field, its clear button, and the compact conductor-scope trigger. */
export function FilterBar({ m, active }: { m: SidebarModel; active: boolean }) {
  const ui = useSidebarUi();
  const { query, focusWanted } = useTextFilter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!active || !focusWanted) return;
    inputRef.current?.focus();
    consumeFilterFocus();
  }, [active, focusWanted]);
  const owner = filterOwner(ui.filter);
  const barRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  // Radix Select has no anchor part, so the menu is aligned to the trigger's end and corrected to the bar: its
  // width is the bar's and `alignOffset` (negated by floating-ui for end alignment) is the trigger-to-bar gap.
  const [menuFit, setMenuFit] = React.useState<{ width: number; offset: number } | null>(null);
  const fitMenu = (open: boolean) => {
    if (!open || !barRef.current || !triggerRef.current) return;
    const bar = barRef.current.getBoundingClientRect();
    const trigger = triggerRef.current.getBoundingClientRect();
    setMenuFit({ width: bar.width, offset: trigger.right - bar.right });
  };
  return (
    <div ref={barRef} data-filter-row className="mx-3 mt-2 flex h-8 items-center rounded-md border bg-background/60">
      <SearchIcon className="mx-2 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        data-filter-input
        type="text"
        aria-label="Filter projects"
        placeholder="Filter…"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          // Prevented, not stopped: the views' and Settings' window-level Escape handlers skip a prevented event.
          e.preventDefault();
          clearQuery();
          e.currentTarget.blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-xs"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => { clearQuery(); inputRef.current?.focus(); }}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
      <span className="h-4 w-px shrink-0 bg-border" />
      <div
        className={cn('max-w-[45%] shrink-0 rounded-md', owner && OWNER_BAR, owner && 'pl-[3px]')}
        style={ownerStyle(owner)}
        data-filter={ui.filter || 'all'}
      >
        <Select value={ui.filter || 'all'} onOpenChange={fitMenu} onValueChange={(v) => setFilter(v === 'all' ? '' : v)}>
          <SelectTrigger ref={triggerRef} size="sm" aria-label="Filter by conductor" title={fullLabel(ui.filter, m.options)} className="h-7 w-auto max-w-full border-0 bg-transparent text-xs shadow-none">
            <SelectValue>{shortLabel(ui.filter, m.options)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" alignOffset={menuFit?.offset ?? 0} style={menuFit ? { width: menuFit.width } : undefined} className="min-w-0">
            {m.options.map((o) => (
              <SelectItem key={o.value || 'all'} value={o.value || 'all'} title={o.label} className="text-xs *:[span]:last:min-w-0">
                <span className="truncate">{o.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

