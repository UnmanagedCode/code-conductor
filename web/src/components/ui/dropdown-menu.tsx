import * as React from 'react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';

const DropdownMenu = (props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) => <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
const DropdownMenuTrigger = (props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) => <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
const DropdownMenuGroup = (props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) => <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
const DropdownMenuRadioGroup = (props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) => <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;

// Below md a submenu does not float beside its parent (no placement fits a phone): activating its trigger replaces
// the parent's items in place, and the trigger row becomes the way back. One level only: a sub nested inside a drilled
// sub renders nothing.
type Drill = { narrow: boolean; drilled: string | null; setDrilled(id: string | null): void };
const DrillContext = React.createContext<Drill | null>(null);
const SubContext = React.createContext<{ id: string } | null>(null);

/** True for an item outside the drilled sub while a sub is drilled in. */
function useDrillHidden(): boolean {
  const drill = React.useContext(DrillContext);
  const sub = React.useContext(SubContext);
  return !!drill?.narrow && drill.drilled !== null && sub?.id !== drill.drilled;
}

// No controlled `open`/`onOpenChange`: the wrapper owns `open` so that narrowing can close it.
function DropdownMenuSub({ defaultOpen = false, ...props }: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.Sub>, 'open' | 'onOpenChange'>) {
  const id = React.useId();
  const narrow = !!React.useContext(DrillContext)?.narrow;
  const [open, setOpen] = React.useState(defaultOpen);
  // A floating sub open when the width narrows is closed for good: it must not reappear open when the width returns.
  React.useEffect(() => { if (narrow) setOpen(false); }, [narrow]);
  return (
    <SubContext.Provider value={React.useMemo(() => ({ id }), [id])}>
      <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} open={open} onOpenChange={setOpen} />
    </SubContext.Provider>
  );
}

const menuSurface =
  'z-50 min-w-[10rem] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';
const itemBase =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground";

const scrollInViewport = 'max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto overflow-x-hidden';

// Mounted by Radix only while the menu is open, so the drill state starts fresh on every open.
function DrillProvider({ children }: { children: React.ReactNode }) {
  const narrow = !useMediaQuery(WIDE_QUERY);
  const [state, setDrilled] = React.useState<string | null>(null);
  const drill = React.useMemo<Drill>(() => ({ narrow, drilled: narrow ? state : null, setDrilled }), [narrow, state]);
  return <DrillContext.Provider value={drill}>{children}</DrillContext.Provider>;
}

function DropdownMenuContent({ className, sideOffset = 6, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset} className={cn(menuSurface, scrollInViewport, className)} {...props}>
        <DrillProvider>{children}</DrillProvider>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}
function DropdownMenuItem({ className, variant = 'default', ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { variant?: 'default' | 'destructive' }) {
  if (useDrillHidden()) return null;
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(itemBase, 'data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:*:[svg]:!text-destructive', className)}
      {...props}
    />
  );
}
function DropdownMenuCheckboxItem({ className, children, checked, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  if (useDrillHidden()) return null;
  return (
    <DropdownMenuPrimitive.CheckboxItem data-slot="dropdown-menu-checkbox-item" className={cn(itemBase, 'pl-8', className)} checked={checked} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator><CheckIcon className="size-4" /></DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}
function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  if (useDrillHidden()) return null;
  return (
    <DropdownMenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" className={cn(itemBase, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator><CheckIcon className="size-4" /></DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}
function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  if (useDrillHidden()) return null;
  return <DropdownMenuPrimitive.Label data-slot="dropdown-menu-label" className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />;
}
function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  if (useDrillHidden()) return null;
  return <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="dropdown-menu-shortcut" className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)} {...props} />;
}
function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  const drill = React.useContext(DrillContext);
  const sub = React.useContext(SubContext);
  if (!drill?.narrow || !sub) {
    return (
      <DropdownMenuPrimitive.SubTrigger data-slot="dropdown-menu-sub-trigger" className={cn(itemBase, 'data-[state=open]:bg-accent', className)} {...props}>
        {children}
        <ChevronRightIcon className="ml-auto size-4" />
      </DropdownMenuPrimitive.SubTrigger>
    );
  }
  if (drill.drilled !== null && drill.drilled !== sub.id) return null;
  // One Item element at one position in both states, so the node and its keyboard focus survive the swap.
  const open = drill.drilled === sub.id;
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-sub-trigger"
      className={cn(itemBase, className)}
      {...(open ? {} : props)}
      aria-expanded={open}
      onSelect={(e) => { e.preventDefault(); drill.setDrilled(open ? null : sub.id); }}
    >
      {open && <ChevronLeftIcon className="size-4" />}
      {children}
      {!open && <ChevronRightIcon className="ml-auto size-4" />}
    </DropdownMenuPrimitive.Item>
  );
}
function DropdownMenuSubContent({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const drill = React.useContext(DrillContext);
  const sub = React.useContext(SubContext);
  if (drill?.narrow && sub) {
    return drill.drilled === sub.id ? <DropdownMenuPrimitive.Group data-slot="dropdown-menu-sub-content" data-drilled="">{children}</DropdownMenuPrimitive.Group> : null;
  }
  return <DropdownMenuPrimitive.SubContent data-slot="dropdown-menu-sub-content" className={cn(menuSurface, scrollInViewport, className)} {...props}>{children}</DropdownMenuPrimitive.SubContent>;
}

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
};
