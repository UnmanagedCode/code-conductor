import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRightLeftIcon, BellIcon, BookOpenIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, ClockIcon,
  CodeXmlIcon, FileTextIcon, GitForkIcon, ListChecksIcon, MailIcon, MicIcon, PaperclipIcon, RecycleIcon,
  RotateCcwIcon, ShrinkIcon, TriangleAlertIcon, TypeIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { OctopusHead } from '@/components/mascot/Octopus';
import { SpeakButton } from '@/features/voice/SpeakButton';
import { voiceStore } from '@/features/voice/store';
import { useStore } from '@/state/createStore';
import { cn } from '@/lib/utils';
import { parseRenewSeed, splitSummarySections } from '@shared/renewSeed';
import { splitForwardedMessages } from '@shared/forwardFrame';
import { ConversationModel, type AssistantNode, type CompactionNode, type DividerNode, type QueuedNode, type RootItem, type SystemNode, type TaskCompletionNode, type TextNode, type TextView, type TurnEndNode, type UserNode } from './model';
import { ActionGroup, CallUsageLine, type RenderCtx } from './tools';
import { fieldText, PlanCard, QuestionCard } from './cards';
import { BubbleBody } from './BubbleBody';
import { compactionLabel, systemLine, taskNotificationHeadline, turnEndParts } from './format';
import { ImageZoom } from './ImageZoom';
import { renderWithSpeakSlot, SPEAK_GUTTER, SPEAK_INLINE, SPEAK_REVEAL } from './speakSlot';

export type BubbleActions = {
  canRewind: boolean;
  canFork: boolean;
  onRewind: (userIndex: number, text: string) => void;
  onFork: (userIndex: number, text: string) => void;
  resolveAttachmentUrl: (filename: string) => string | null;
};

export const ItemsList = React.memo(function ItemsList({ model, ctx, actions }: { model: ConversationModel; rev: number; ctx: RenderCtx; actions: BubbleActions | null }) {
  const cur = model.currentSegment();
  return (
    <>
      {model.items.map((it, i) => {
        if (repeatsUsageAbove(model.items[i - 1], it)) return null;
        // A dropped repeat always follows a rendered usage line, so adjacency in model.items is adjacency in the DOM.
        const carries = controlsCarrier(model.items[i - 1], it) ? model.items[i - 1] as AssistantNode : null;
        return (
          <RootItemView key={it.id} node={it} rev={it.rev} ctx={ctx} actions={actions} currentSegment={cur}
            controlsBelow={controlsCarrier(it, model.items[i + 1])} carries={carries} carriesRev={carries?.rev ?? -1} />
        );
      })}
    </>
  );
});

/** A usage line that renders the same as the one right above it: the CLI re-reports usage on every API call. */
function repeatsUsageAbove(above: RootItem | undefined, it: RootItem): boolean {
  if (it.type !== 'system' || it.ev.subtype !== 'rate_limit_event') return false;
  if (above?.type !== 'system' || above.ev.subtype !== 'rate_limit_event') return false;
  const a = systemLine(above.ev), b = systemLine(it.ev);
  return a.text === b.text && a.tone === b.tone && a.title === b.title;
}

/** The bubble directly above a turn-end row: its raw toggle and copy move onto that row. */
function controlsCarrier(above: RootItem | undefined, it: RootItem | undefined): above is AssistantNode {
  return it?.type === 'turn_end' && above?.type === 'assistant';
}

function assistantHasText(node: AssistantNode): boolean {
  return node.children.some((c) => c.type === 'text') || !!node.planText;
}

const RootItemView = React.memo(function RootItemView({ node, ctx, actions, currentSegment, controlsBelow, carries }: {
  node: RootItem; rev: number; ctx: RenderCtx; actions: BubbleActions | null; currentSegment: string | null;
  controlsBelow: boolean; carries: AssistantNode | null; carriesRev: number;
}) {
  switch (node.type) {
    case 'user': return <UserBubble node={node} model={ctx.model} actions={actions} currentSegment={currentSegment} />;
    case 'assistant': return <AssistantBubble node={node} ctx={ctx} controlsBelow={controlsBelow} />;
    case 'system': return <SystemLineView node={node} model={ctx.model} />;
    case 'turn_end': return <TurnEndView node={node} carries={carries} model={ctx.model} />;
    case 'plan': return <div data-item="plan"><PlanCard node={node} model={ctx.model} /></div>;
    case 'question': return <div data-item="question"><QuestionCard node={node} model={ctx.model} /></div>;
    case 'task_completion': return <TaskCompletionView node={node} />;
    case 'queued': return <QueuedView node={node} />;
    case 'compaction': return <CompactionView node={node} model={ctx.model} />;
    case 'divider': return <DividerView node={node} />;
  }
}, (a, b) => a.node === b.node && a.rev === b.rev && a.actions === b.actions && a.currentSegment === b.currentSegment && a.ctx === b.ctx
  && a.controlsBelow === b.controlsBelow && a.carries === b.carries && a.carriesRev === b.carriesRev);

// ── User ─────────────────────────────────────────────────────────────────

function ViewToggle({ view, onChange }: { view: 'rendered' | 'raw'; onChange: (v: 'rendered' | 'raw') => void }) {
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

// Single newlines inside a paragraph are line breaks people typed: keep them.
const MD_TEXT = 'whitespace-pre-wrap';
/**
 * Where every user-authored item starts: one avatar gutter right of where assistant text starts. At `md` and up the
 * text starts past the avatar + gap (2.75rem) and the gutter is that again; below it the text starts at
 * ASSISTANT_PROSE_INSET and the gutter is the avatar's width. The item then fills to the column's right edge.
 */
export const USER_INSET = 'ml-9.5 md:ml-22';
/**
 * USER_INSET inside a sub-agent panel, whose bubbles have no avatar: at `md` and up the text starts at the panel's
 * content edge, so one gutter is 2.75rem; below it the text and the gutter are as at the root.
 */
export const USER_INSET_SUB = 'ml-9.5 md:ml-11';
/** A user bubble's horizontal padding; the attachments and the action row below it share it, so they start at its text. */
const USER_BUBBLE_PAD_X = 'px-4';
/** A user bubble: a soft tint and an accent strip on its right edge, the side its author speaks from; no outline. A tone adds the colours. */
export const USER_BUBBLE = `rounded-l-2xl rounded-r-md border-r-[3px] py-2.5 ${USER_BUBBLE_PAD_X}`;
/** The tone of a prompt a person typed (and of the sticky pin that repeats one). */
export const USER_TONE_PROMPT = 'bg-primary/10 dark:bg-primary/15 border-r-primary/60';

function UserText({ text, view }: { text: string; view: 'rendered' | 'raw' }) {
  return view === 'raw'
    ? <div className="text-[15px] leading-relaxed whitespace-pre-wrap wrap-anywhere" data-view="raw">{text}</div>
    : <Markdown text={text} className={MD_TEXT} />;
}

function Folded({ icon, title, children, tone = 'muted', kind, multiline = false, open, onOpenChange }: {
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

function FoldedBody({ text, render, view, onViewChange }: { text: string; render?: () => React.ReactNode; view: TextView; onViewChange: (view: TextView) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-end gap-0.5">
        <ViewToggle view={view} onChange={onViewChange} />
        <CopyButton getText={() => text} label="Copy text" />
      </div>
      <BubbleBody>
        {view === 'raw' ? <pre className="text-sm whitespace-pre-wrap wrap-anywhere" data-view="raw">{text}</pre> : render ? render() : <Markdown text={text} className={MD_TEXT} />}
      </BubbleBody>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</div>
      {children}
    </section>
  );
}

function RenewBody({ text }: { text: string }) {
  const parsed = parseRenewSeed(text);
  if (!parsed) return <Markdown text={text} />;
  return (
    <div className="space-y-4">
      {splitSummarySections(parsed.summary).map((s: { title: string | null; body: string }, i: number) => (
        <Section key={i} label={s.title ?? 'Handoff summary'}><Markdown text={s.body} className={MD_TEXT} /></Section>
      ))}
      {parsed.followUp && <Section label="Conductor's follow-up directive"><Markdown text={parsed.followUp} className={MD_TEXT} /></Section>}
      {parsed.state && <Section label="Mechanical state (server-generated)"><pre className="text-xs whitespace-pre-wrap text-muted-foreground">{parsed.state}</pre></Section>}
    </div>
  );
}

function ForwardBody({ payload }: { payload: string }) {
  const bodies: string[] = splitForwardedMessages(payload);
  return (
    <div className="space-y-4">
      {bodies.map((b, i) => (
        <Section key={i} label={bodies.length > 1 ? `Message ${i + 1}/${bodies.length}` : 'Forwarded output'}><Markdown text={b} className={MD_TEXT} /></Section>
      ))}
    </div>
  );
}

function WakeBody({ body }: { body: string }) {
  const nl = body.indexOf('\n');
  const meta = nl === -1 ? body : body.slice(0, nl);
  const rest = nl === -1 ? '' : body.slice(nl + 1);
  return (
    <div className="space-y-2">
      <div className="font-mono text-xs wrap-anywhere text-muted-foreground" data-wake-meta>{meta}</div>
      <Markdown text={rest} className={MD_TEXT} />
    </div>
  );
}

function Attachments({ list, resolve }: { list: any[]; resolve?: (f: string) => string | null }) {
  if (!list.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-2', USER_BUBBLE_PAD_X)} data-user-attachments>
      {list.map((a, i) => {
        if (a?.kind === 'image') {
          const src = typeof a.dataBase64 === 'string'
            ? `data:${a.mediaType || 'image/png'};base64,${a.dataBase64}`
            : a.filename && resolve ? resolve(a.filename) : null;
          if (src) return <ImageZoom key={i} src={src} alt={a.name || 'Attached image'} className="max-h-48 rounded-xl border" />;
        }
        return (
          <span key={i} className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-xs">
            <PaperclipIcon className="size-3.5 text-muted-foreground" />
            {a?.name ?? a?.path ?? 'file'}
            {a?.path && <span className="text-muted-foreground">({a.path})</span>}
          </span>
        );
      })}
    </div>
  );
}

function AnswerSummary({ answer }: { answer: NonNullable<UserNode['answer']> }) {
  if (!answer.answers) return null;
  return (
    <div className="space-y-2">
      {answer.questions.map((q: any, i: number) => {
        const a = answer.answers![i];
        return (
          <div key={i} className="space-y-1" data-kind={a.kind}>
            <div className="text-xs text-muted-foreground">{fieldText(q?.header) && <span className="mr-1 font-semibold uppercase">{fieldText(q.header)}</span>}{fieldText(q?.question) ?? ''}</div>
            <div className="flex flex-wrap gap-1.5">
              {a.kind === 'option' && <span className="rounded-full bg-primary/12 px-2 py-0.5 text-sm text-primary" data-choice>{a.label}</span>}
              {a.kind === 'multi' && a.labels.map((l: string) => <span key={l} className="rounded-full bg-primary/12 px-2 py-0.5 text-sm text-primary" data-choice>{l}</span>)}
              {a.kind === 'custom' && <span className="text-sm" data-custom>{a.text}</span>}
              {a.kind === 'none' && <span className="text-sm text-muted-foreground italic" data-skipped>skipped</span>}
            </div>
            {a.note && <div className="text-xs text-muted-foreground" data-note>— {a.note}</div>}
          </div>
        );
      })}
    </div>
  );
}

function UserBubble({ node, model, actions, currentSegment }: { node: UserNode; model: ConversationModel; actions: BubbleActions | null; currentSegment: string | null }) {
  const view = node.reader.view;
  const setView = (v: TextView) => model.setReader(node, { view: v });
  const fold = { open: node.reader.foldOpen, onOpenChange: (o: boolean) => model.setReader(node, { foldOpen: o }) };
  const body = { view: node.reader.foldView, onViewChange: (v: TextView) => model.setReader(node, { foldView: v }) };
  const hasTextControls = !!node.displayText && !(node.answer && node.answer.answers);
  const canAct = !model.isSub && !!actions && node.userIndex != null && (currentSegment == null || node.segmentId === currentSegment);
  const folded = (
    <>
      {node.skill && (
        <Folded kind="skill" icon={<BookOpenIcon className="size-4" />} title={`Loading skill: ${node.skill.name}`} {...fold}>
          {() => <FoldedBody text={node.skill!.text} {...body} />}
        </Folded>
      )}
      {node.wake && (node.wake.body
        ? <Folded kind="wake" multiline icon={<BellIcon className="size-4" />} title={node.wake.summary} {...fold}>{() => <FoldedBody text={node.wake!.body!} render={() => <WakeBody body={node.wake!.body!} />} {...body} />}</Folded>
        : <div className="flex items-start gap-2 rounded-xl border bg-card px-3 py-2 text-sm whitespace-pre-line wrap-anywhere text-muted-foreground" data-wake-plain><BellIcon className="mt-0.5 size-4 shrink-0" />{node.wake.summary}</div>)}
      {node.renew && (
        <Folded kind="renew" icon={<RecycleIcon className="size-4" />} title="Context renewed · handoff summary" tone="info" {...fold}>
          {() => <FoldedBody text={node.renew!.text} render={() => <RenewBody text={node.renew!.text} />} {...body} />}
        </Folded>
      )}
      {node.forward && (
        <Folded kind="forward" icon={<MailIcon className="size-4" />} title={`Forwarded worker output · ${node.forward.count} message${node.forward.count === 1 ? '' : 's'}`} {...fold}>
          {() => <FoldedBody text={node.forward!.payload} render={() => <ForwardBody payload={node.forward!.payload} />} {...body} />}
        </Folded>
      )}
    </>
  );
  const injected = node.variant === 'wake' || node.variant === 'renew' || !!node.skill;
  return (
    <div className={cn('group/user flex flex-col gap-1.5', model.isSub ? USER_INSET_SUB : USER_INSET)} data-item="user" data-variant={node.variant} data-user-index={node.userIndex ?? undefined} data-prompt-origin={node.origin}>
      {(node.skill || node.wake || node.renew || node.forward) && <div className="space-y-2">{folded}</div>}
      {node.answer ? (
        <div className={cn(USER_BUBBLE, 'bg-info/8 border-r-info/60')}>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-info" data-answer-head>
            <CircleCheckIcon className="size-3.5" /> {node.answer.questions.length > 1 ? `Answered · ${node.answer.questions.length} questions` : 'Answered'}
          </div>
          {node.answer.answers ? <AnswerSummary answer={node.answer} /> : <UserText text={node.displayText} view={view} />}
        </div>
      ) : node.displayText ? (
        <div data-user-text className={cn(USER_BUBBLE, injected ? 'bg-muted border-r-muted-foreground/40' : USER_TONE_PROMPT)}>
          <UserText text={node.displayText} view={view} />
        </div>
      ) : null}
      <Attachments list={node.attachments} resolve={actions?.resolveAttachmentUrl} />
      <div className={cn('flex items-center gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100', USER_BUBBLE_PAD_X)} data-user-actions>
        {node.transcribed && (
          <Tooltip><TooltipTrigger asChild><span className="px-1 text-muted-foreground" data-voice-badge><MicIcon className="size-3.5" /></span></TooltipTrigger><TooltipContent>Transcribed from voice</TooltipContent></Tooltip>
        )}
        {hasTextControls && (
          <>
            <ViewToggle view={view} onChange={setView} />
            <CopyButton getText={() => node.displayText} label="Copy message" />
          </>
        )}
        {canAct && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" disabled={!actions!.canRewind} aria-label="Rewind to before this message"
                  onClick={() => actions!.onRewind(node.userIndex!, node.rawText)}>
                  <RotateCcwIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Rewind to before this message</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" disabled={!actions!.canFork} aria-label="Fork a new session from here"
                  onClick={() => actions!.onFork(node.userIndex!, node.rawText)}>
                  <GitForkIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Fork a new session from here</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

// ── Assistant ────────────────────────────────────────────────────────────

/**
 * One text block of an assistant bubble. A finished block's read-aloud sits after its last word, in a slot the
 * markdown render appends to its last paragraph, list item or quote, or on a row of its own when the block
 * ends in anything else. Every block but the bubble's first (whose gutter holds the avatar) moves it into the gutter at `md` and up.
 */
function TextBlock({ node, view, first, isSub }: { node: TextNode; view: TextView; first: boolean; isSub: boolean }) {
  const ttsAvailable = useStore(voiceStore, (s) => s.ttsAvailable);
  const speaks = node.finalized && !isSub && ttsAvailable;
  const gutter = speaks && !first;
  // A streaming block shows its raw deltas; it renders markdown once finalized.
  const rendered = node.finalized && view !== 'raw';
  // The current render's slot: undefined until the markdown has rendered, null when its last block has no inline end.
  const [slot, setSlot] = React.useState<HTMLElement | null | undefined>(undefined);
  const renderInto = React.useCallback((el: HTMLElement, text: string) => setSlot(renderWithSpeakSlot(el, text)), []);
  // Forget the slot while the markdown is gone or rendered without one: otherwise the render that brings the rendered view
  // or the voice back would mount the control for one commit into that old, detached slot, before Markdown hands over a fresh one.
  React.useLayoutEffect(() => { if (!speaks || !rendered) setSlot(undefined); }, [speaks, rendered]);
  const button = <SpeakButton text={node.buffer} nodeId={node.id} className={cn(SPEAK_INLINE, gutter && SPEAK_GUTTER, SPEAK_REVEAL)} />;
  const end = !speaks ? undefined : !rendered ? 'inline' : slot === undefined ? undefined : slot ? 'inline' : 'row';
  return (
    <div data-text-block data-speak-end={end} data-speak-gutter={gutter || undefined} className={cn(speaks && 'group/speak relative')}>
      <div className={ASSISTANT_PROSE_INSET}>
        {rendered
          ? <Markdown text={node.buffer} className={MD_TEXT} renderInto={speaks ? renderInto : undefined} />
          : (
            <div className="text-[15px] leading-relaxed whitespace-pre-wrap">
              {node.buffer}
              {!node.finalized && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-primary/60 align-text-bottom" />}
              {speaks && <span data-speak-slot>{button}</span>}
            </div>
          )}
      </div>
      {rendered && end === 'inline' && slot && createPortal(button, slot)}
      {/* In the gutter the row holds only an out-of-flow button; as a block box it collapses, letting the code's margin through. */}
      {rendered && end === 'row' && <div data-speak-slot className={cn('flex', gutter && 'md:block')}>{button}</div>}
    </div>
  );
}

/** Phone-only inset of an assistant turn's prose, so it does not sit flush with the action cards' border; cards and controls keep the transcript edge. */
const ASSISTANT_PROSE_INSET = 'px-1.5 md:px-0';

// The bubble's controls show while it is hovered or one of them has focus, and always where nothing hovers.
const ASSISTANT_CONTROLS_REVEAL = 'opacity-0 transition-opacity group-hover/asst:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100';
// On the turn-end row the controls belong to the bubble above it, so hovering either reveals them.
const TURN_END_CONTROLS_REVEAL = `${ASSISTANT_CONTROLS_REVEAL} [[data-item=assistant]:hover+[data-item=turn-end]_&]:opacity-100`;

/** The raw/rendered toggle and copy of one assistant bubble, wherever they are placed. */
function AssistantControls({ node, model, className }: { node: AssistantNode; model: ConversationModel; className: string }) {
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <ViewToggle view={node.view} onChange={(v) => model.setAssistantView(node, v)} />
      <CopyButton getText={() => ConversationModel.assistantCopyText(node)} label="Copy message" />
    </div>
  );
}

function AssistantBubble({ node, ctx, controlsBelow }: { node: AssistantNode; ctx: RenderCtx; controlsBelow: boolean }) {
  return (
    <div className="group/asst flex flex-col gap-2 md:flex-row md:gap-3" data-item="assistant">
      {!ctx.model.isSub && (
        <div data-assistant-avatar className="md:mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/15">
          <OctopusHead className="size-6" />
        </div>
      )}
      <div data-assistant-body className="min-w-0 md:flex-1 space-y-3">
        {node.children.map((c, i) => {
          if (c.type === 'text') return <TextBlock key={c.id} node={c} view={node.view} first={i === 0} isSub={ctx.model.isSub} />;
          if (c.type === 'group') return <ActionGroup key={c.id} node={c} rev={c.rev} ctx={ctx} />;
          return <CallUsageLine key={c.id} node={c} />;
        })}
        {assistantHasText(node) && !controlsBelow && (
          <AssistantControls node={node} model={ctx.model} className={cn('justify-end', ASSISTANT_CONTROLS_REVEAL)} />
        )}
      </div>
    </div>
  );
}

// ── Annotations ──────────────────────────────────────────────────────────

function SystemLineView({ node, model }: { node: SystemNode; model: ConversationModel }) {
  const ev = node.ev;
  if (ev.subtype === 'task_notification') {
    const d = ev.data ?? {};
    const failed = d.status === 'failed';
    return (
      <details
        open={node.reader.open}
        onToggle={(e) => { if (e.currentTarget.open !== node.reader.open) model.setReader(node, { open: e.currentTarget.open }); }}
        className={cn('group/tn rounded-lg border px-3 py-2 text-sm', failed ? 'border-warning/40 bg-warning/8' : 'bg-card')} data-subtype="task_notification" data-tone={failed ? 'warn' : 'muted'}>
        <summary className="flex cursor-pointer items-center gap-2 select-none">
          <ListChecksIcon className={cn('size-4', failed ? 'text-warning' : 'text-muted-foreground')} />
          <span data-headline>{taskNotificationHeadline(d)}</span>
        </summary>
        <div className="mt-2 space-y-1 text-muted-foreground" data-fold-body>
          <div>{d.summary ?? ''}</div>
          {d.output_file && <div className="font-mono text-xs">output: {d.output_file}</div>}
        </div>
      </details>
    );
  }
  const line = systemLine(ev);
  const Icon = line.tone === 'warn' ? TriangleAlertIcon : line.tone === 'error' ? CircleAlertIcon : ArrowRightLeftIcon;
  if (ev.subtype === 'stderr' || ev.subtype === 'raw') {
    return <pre className="overflow-x-auto rounded-lg bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground" data-subtype={ev.subtype} data-tone={line.tone}>{line.text}</pre>;
  }
  return (
    <div className="flex items-center gap-3 text-xs" data-subtype={ev.subtype} data-tone={line.tone} title={line.title ?? undefined}>
      <div className="h-px flex-1 bg-border" />
      <span className={cn(
        'flex max-w-[85%] items-center gap-1.5 rounded-full border px-2.5 py-1',
        line.tone === 'warn' && 'border-warning/40 bg-warning/8 text-warning',
        line.tone === 'error' && 'border-destructive/40 bg-destructive/8 text-destructive',
        line.tone === 'muted' && 'bg-background text-muted-foreground',
      )}>
        <Icon className="size-3 shrink-0" />
        <span className="min-w-0 break-words" data-detail>{line.text}</span>
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function TurnEndView({ node, carries, model }: { node: TurnEndNode; carries: AssistantNode | null; model: ConversationModel }) {
  const p = turnEndParts(node.ev);
  return (
    <div className="group/asst flex items-center gap-x-3 md:pl-11 text-xs text-muted-foreground tabular-nums" data-item="turn-end">
      <div data-turn-stats className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cn('flex items-center gap-1', p.ok ? 'text-success' : 'text-destructive')}>
          {p.ok ? <CircleCheckIcon className="size-3.5" /> : <CircleAlertIcon className="size-3.5" />}
          {p.ok ? 'Done' : 'Turn failed'}{p.stopReason && p.stopReason !== 'end_turn' && ` · ${p.stopReason}`}
        </span>
        {p.duration && <span>{p.duration}</span>}
        {p.cost && <span>{p.cost}</span>}
        {p.context && <span>{p.context}</span>}
        {p.tokens && <span>{p.tokens}</span>}
      </div>
      {carries && assistantHasText(carries) && <AssistantControls node={carries} model={model} className={`shrink-0 ${TURN_END_CONTROLS_REVEAL}`} />}
    </div>
  );
}

function TaskCompletionView({ node }: { node: TaskCompletionNode }) {
  return (
    <div className="rounded-xl border border-success/30 bg-success/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-success">
        <ListChecksIcon className="size-4" /> Tasks · {node.tasks.length}/{node.tasks.length} done
      </div>
      <ul className="space-y-1 text-sm">
        {node.tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-2"><CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" /><span>{t.subject}</span></li>
        ))}
      </ul>
    </div>
  );
}

function QueuedView({ node }: { node: QueuedNode }) {
  const d = node.ev.data ?? {};
  let clock = '';
  try { if (d.ts) clock = new Date(d.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { /* bad ts */ }
  // Delivered, the ghost stays where it was queued, dimmed, above the turn that delivered it.
  return (
    <div className={cn(USER_INSET, node.delivered && 'opacity-40')} data-item="queued" data-delivered={node.delivered || undefined}>
      <div className={cn('border border-dashed', USER_BUBBLE, 'border-r-muted-foreground/40 text-muted-foreground')}>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase">
          <ClockIcon className="size-3" /> Queued{clock && ` · ${clock}`}
          {d.attachmentCount > 0 && <span className="flex items-center gap-0.5"><PaperclipIcon className="size-3" />{d.attachmentCount}</span>}
        </div>
        <div className="text-[15px] whitespace-pre-wrap">{d.text ?? ''}</div>
      </div>
    </div>
  );
}

function CompactionView({ node, model }: { node: CompactionNode; model: ConversationModel }) {
  const label = compactionLabel(node);
  const icon = <ShrinkIcon className={cn('size-4', node.state === 'running' && 'animate-pulse', node.state === 'failed' && 'text-destructive')} />;
  if (node.summary == null) {
    return <div className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm text-muted-foreground">{icon}{label}</div>;
  }
  return (
    <Folded kind="compaction" icon={icon} title={label} open={node.reader.open} onOpenChange={(o) => model.setReader(node, { open: o })}>
      {() => <FoldedBody text={node.summary!} view={node.reader.view} onViewChange={(v) => model.setReader(node, { view: v })} />}
    </Folded>
  );
}

function DividerView({ node }: { node: DividerNode }) {
  const label = node.kind === 'gap' ? 'Earlier messages unavailable'
    : node.kind === 'seam' ? 'Context renewed'
    : `${node.count ?? 0} prior message${node.count === 1 ? '' : 's'} replayed · new turn below`;
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase" data-divider={node.kind}>
      <div className="h-px flex-1 bg-border" />
      {node.kind === 'seam' ? <RecycleIcon className="size-3" /> : <FileTextIcon className="size-3" />}
      {label}
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
