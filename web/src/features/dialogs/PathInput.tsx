// Directory autocomplete for an absolute-path field (Adopt's Directory, New
// project's "Path on that system"). The field stays plain text: whatever is in
// it is what the dialog submits; the list only helps type it. One debounced
// GET /api/fs/dirs per (system, remote, directory), cached until reset (a
// transient refusal is not cached), filtered locally as the last segment is
// typed. Tab / Enter / click complete; arrows move; Escape closes.
import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { apiFetch } from '@shared/http';

export const PATH_PICKER_DEBOUNCE_MS = 250;
export const TRANSIENT_REFUSAL_CODES = new Set(['LIST_TIMEOUT', 'ETIMEDOUT', 'ETRANSPORT', 'SYSTEM_UNREACHABLE']);

export type Placement = { system: string | null; remoteId: string | null };

export function splitPath(value: string) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const i = value.lastIndexOf('/');
  return { dir: i === 0 ? '/' : value.slice(0, i), dirSlash: value.slice(0, i + 1), prefix: value.slice(i + 1) };
}

type Entry =
  | { names: string[]; unresolved: Set<string>; truncated: boolean; max?: number }
  | { refusal: { reason: string } };

const keyOf = (p: Placement, dir: string) => `${p.system ?? 'local'}\n${p.remoteId ?? ''}\n${dir}`;

export type PathInputProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placement: Placement;
  /** Changing this clears the cache and any pending listing (the placement moved). */
  resetKey?: unknown;
  placeholder?: string;
  className?: string;
  'aria-invalid'?: boolean;
};

export function PathInput({ id, value, onChange, placement, resetKey, placeholder, className, ...rest }: PathInputProps) {
  const listId = `${id}-completions`;
  const cache = React.useRef(new Map<string, Entry>());
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = React.useRef<AbortController | null>(null);
  const inflightDir = React.useRef<string | null>(null);
  const seq = React.useRef(0);
  const [shown, setShown] = React.useState<{ names: string[]; unresolved: Set<string>; dirSlash: string } | null>(null);
  const [active, setActive] = React.useState(-1);
  const [note, setNote] = React.useState('');
  const placementRef = React.useRef(placement);
  placementRef.current = placement;
  const valueRef = React.useRef(value);
  valueRef.current = value;

  const close = () => { setShown(null); setActive(-1); };
  const abort = () => {
    controller.current?.abort();
    controller.current = null;
    inflightDir.current = null;
  };
  const clearTimer = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };

  React.useEffect(() => {
    clearTimer();
    abort();
    seq.current++;
    cache.current.clear();
    close();
    setNote('');
  }, [resetKey]);

  React.useEffect(() => () => { clearTimer(); abort(); }, []);

  function show(entry: Entry, s: NonNullable<ReturnType<typeof splitPath>>) {
    if ('refusal' in entry) {
      close();
      setNote(entry.refusal.reason || `Could not list ${s.dir}.`);
      return;
    }
    const names = entry.names.filter((n) => n.startsWith(s.prefix) && (s.prefix.startsWith('.') || !n.startsWith('.')));
    setNote(entry.truncated ? `${s.dir} has more than ${entry.max} directories; only the first ${entry.max} by name are offered.` : '');
    if (!names.length) { close(); return; }
    setShown({ names, unresolved: entry.unresolved, dirSlash: s.dirSlash });
    setActive(-1);
  }

  async function fetchDir(s: NonNullable<ReturnType<typeof splitPath>>, p: Placement, key: string) {
    abort();
    const mySeq = ++seq.current;
    const ctl = new AbortController();
    controller.current = ctl;
    inflightDir.current = s.dir;
    const params = new URLSearchParams({ path: s.dir });
    if (p.system) params.set('system', p.system);
    if (p.remoteId) params.set('remoteId', p.remoteId);
    setNote(`Listing ${s.dir}…`);
    let data: any;
    try {
      data = await apiFetch('/api/fs/dirs?' + params, { signal: ctl.signal });
    } catch (e: any) {
      if (mySeq !== seq.current || e?.name === 'AbortError') return;
      inflightDir.current = null;
      setNote(`Could not list ${s.dir} (${e.message}).`);
      return;
    }
    if (mySeq !== seq.current) return;
    inflightDir.current = null;
    const entry: Entry = data?.ok === true
      ? {
        names: [...(data.entries ?? []), ...(data.links ?? [])].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)),
        unresolved: new Set(data.links ?? []),
        truncated: !!data.truncated,
        max: data.max,
      }
      : { refusal: { reason: typeof data?.reason === 'string' ? data.reason : '' } };
    if (!('refusal' in entry && TRANSIENT_REFUSAL_CODES.has(data?.code))) cache.current.set(key, entry);
    const now = splitPath(valueRef.current);
    if (!now || now.dir !== s.dir) return;
    show(entry, now);
  }

  function onValue(next: string) {
    onChange(next);
    clearTimer();
    const s = splitPath(next);
    if (!s) {
      abort();
      seq.current++;
      close();
      setNote('');
      return;
    }
    const p = placementRef.current;
    const key = keyOf(p, s.dir);
    const hit = cache.current.get(key);
    if (hit) {
      abort();
      seq.current++;
      show(hit, s);
      return;
    }
    if (inflightDir.current !== null && inflightDir.current !== s.dir) { abort(); seq.current++; }
    close();
    setNote('');
    timer.current = setTimeout(() => {
      timer.current = null;
      void fetchDir(s, p, key);
    }, PATH_PICKER_DEBOUNCE_MS);
  }

  function complete(name: string | undefined) {
    if (!shown || name === undefined) return;
    const next = shown.dirSlash + name + '/';
    close();
    onValue(next);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!shown || !shown.names.length) return;
    const n = shown.names.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1);
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      complete(shown.names[active >= 0 ? active : 0]);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      complete(shown.names[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  const open = !!shown && shown.names.length > 0;

  // An Escape that closes the open list must not also close the dialog around
  // it. Radix dismisses a dialog from a capture-phase keydown listener on
  // document, which runs before any handler on the field, unless the event is
  // already defaultPrevented. A capture listener on window runs before that one.
  // onKeyDown still closes the list.
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const claim = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && e.target === inputRef.current) e.preventDefault();
    };
    window.addEventListener('keydown', claim, true);
    return () => window.removeEventListener('keydown', claim, true);
  }, [open]);

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={close}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
        className={cn('font-mono text-sm', className)}
        {...rest}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 text-sm shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          {shown!.names.map((name, i) => (
            <li
              key={name}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              title={shown!.unresolved.has(name) ? 'Symlink, not checked to be a directory' : undefined}
              onClick={() => complete(name)}
              className={cn(
                'cursor-pointer truncate rounded-md px-2 py-1 font-mono',
                i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                shown!.unresolved.has(name) && 'italic text-muted-foreground',
              )}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mt-1 text-xs text-muted-foreground" data-path-note>{note}</p>}
    </div>
  );
}
