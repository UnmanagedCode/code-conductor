// The transcript's fold primitives — a collapsed titled row whose body is built
// on first expand, the rendered/raw toggle and copy row of a folded text, the
// right-aligned action row — shared by the root items (./items.tsx) and the
// tool cards (./tools.tsx), plus the hook-context fold both place.
import * as React from 'react';
import { ChevronRightIcon, CodeXmlIcon, TypeIcon, WebhookIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { cn } from '@/lib/utils';
import { toolNamePlain } from '@shared/toolName';
import type { ConversationModel, HookContextNode, TextView } from './model';
import { BubbleBody } from './BubbleBody';

// Single newlines inside a paragraph are line breaks people typed: keep them.
export const MD_TEXT = 'whitespace-pre-wrap';

export function ViewToggle({ view, onChange }: { view: 'rendered' | 'raw'; onChange: (v: 'rendered' | 'raw') => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" aria-label={view === 'raw' ? 'Show rendered markdown' : 'Show raw text'}
          onClick={(e) => { e.stopPropagation(); onChange(view === 'raw' ? 'rendered' : 'raw'); }}>
          {view === 'raw' ? <TypeIcon className="size-3.5" /> : <CodeXmlIcon className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{view === 'raw' ? 'Show rendered markdown' : 'Show raw text'}</TooltipContent>
    </Tooltip>
  );
}

export function Folded({ icon, title, children, tone = 'muted', kind, multiline = false, open, onOpenChange }: {
  icon: React.ReactNode; title: React.ReactNode; children: () => React.ReactNode; tone?: 'muted' | 'info'; kind: string; multiline?: boolean;
  open: boolean; onOpenChange: (open: boolean) => void;
}) {
  // The body is built on first expand and kept afterwards: Radix renders no
  // children while closed, so forceMount keeps the built body mounted and
  // `hidden` hides it.
  const [opened, setOpened] = React.useState(open);
  return (
    <Collapsible open={open} onOpenChange={(o) => { onOpenChange(o); if (o) setOpened(true); }} className={cn('rounded-xl border bg-card', tone === 'info' && 'border-info/30')} data-fold={kind}>
      <CollapsibleTrigger className="group/fold flex w-full items-center gap-2 px-3 py-2 text-left text-sm" data-fold-trigger>
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className={cn('min-w-0 flex-1', multiline ? 'whitespace-pre-line wrap-anywhere' : 'truncate')} data-fold-title>{title}</span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/fold:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount hidden={!open} className="border-t px-3 py-3">{opened && children()}</CollapsibleContent>
    </Collapsible>
  );
}

/** A transcript item's row of helper icons (raw toggle, copy, rewind, fork). Every such row is right-aligned. */
export function ActionRow({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-action-row className={cn('flex items-center justify-end gap-0.5', className)} {...props} />;
}

export function FoldedBody({ text, render, view, onViewChange }: { text: string; render?: () => React.ReactNode; view: TextView; onViewChange: (view: TextView) => void }) {
  return (
    <div className="space-y-2">
      <ActionRow>
        <ViewToggle view={view} onChange={onViewChange} />
        <CopyButton getText={() => text} label="Copy text" />
      </ActionRow>
      <BubbleBody>
        {view === 'raw' ? <pre className="text-sm whitespace-pre-wrap wrap-anywhere" data-view="raw">{text}</pre> : render ? render() : <Markdown text={text} className={MD_TEXT} />}
      </BubbleBody>
    </div>
  );
}

/** The icon a hook context's fold and its tool card's marker share. */
export function HookContextIcon({ className }: { className?: string }) {
  return <WebhookIcon className={className} />;
}

/**
 * What a hook added to the model's context, collapsed by default: recall runs to several KB, and reading it is an
 * opt-in audit. `withTool` names the hooked tool, for a row shown outside its card.
 */
export function HookContextFold({ node, model, withTool = false }: { node: HookContextNode; model: ConversationModel; withTool?: boolean }) {
  const { ev } = node;
  const title = `Hook context · ${ev.hookEvent}${withTool && ev.toolName ? ` · ${toolNamePlain(ev.toolName)}` : ''}`;
  return (
    <div data-hook-context data-hook-event={ev.hookEvent}>
      <Folded kind="hook-context" icon={<HookContextIcon className="size-4" />} title={title}
        open={node.reader.open} onOpenChange={(o) => model.setReader(node, { open: o })}>
        {() => <FoldedBody text={ev.text} view={node.reader.view} onViewChange={(v) => model.setReader(node, { view: v })} />}
      </Folded>
    </div>
  );
}
