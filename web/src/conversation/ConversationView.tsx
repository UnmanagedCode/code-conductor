import * as React from 'react';
import { ArrowDownIcon, LoaderCircleIcon, HistoryIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/state/createStore';
import { appStore, activeInstance } from '@/state/app';
import { conversation, lazyHistory, stickyPrompt } from '@/app/controller';
import { pinStore, trackSwipes } from './stickyPrompt';
import { forkActiveSession, rewindActiveSession } from '@/app/sessionActions';
import { peekTaskTracker } from '@/app/trackers';
import { uiStore } from '@/app/ui';
import { ItemsList, type BubbleActions } from './items';
import { userActionsForStatus, type ConversationModel } from './model';
import type { RenderCtx } from './tools';
import { cn } from '@/lib/utils';

function useModelRev(model: ConversationModel) {
  return React.useSyncExternalStore(model.subscribe, model.getRev, model.getRev);
}

/** A nested sub-agent conversation: its own items, sharing the outer render context. */
function SubConversation({ model, ctx }: { model: ConversationModel; ctx: RenderCtx }) {
  const subCtx = React.useMemo<RenderCtx>(() => ({ ...ctx, model }), [ctx, model]);
  return <ItemsList model={model} rev={model.rev} ctx={subCtx} actions={null} />;
}

export function ConversationView({ empty }: { empty?: React.ReactNode }) {
  const rev = useModelRev(conversation);
  const inst = useStore(appStore, activeInstance);
  const callUsage = useStore(uiStore, (s) => s.callUsageShown);
  const lazy = useStore(lazyHistory.status, (s) => s);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const pinRef = React.useRef<HTMLDivElement>(null);
  const pin = useStore(pinStore, (s) => s.pin);
  const sticky = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);

  const activeId = inst?.id ?? null;
  const showCallUsage = !!inst?.sessionId && !!callUsage[inst.sessionId];
  const status = inst?.status ?? null;

  const ctx = React.useMemo<RenderCtx>(() => {
    const base: RenderCtx = {
      model: conversation,
      describeCtx: {
        resolveTaskSubject: (id) => peekTaskTracker(appStore.get().activeId)?.getSubject(id) ?? null,
        resolveTaskDescription: (id) => peekTaskTracker(appStore.get().activeId)?.getDescription(id) ?? null,
      },
      renderSub: () => null,
    };
    base.renderSub = (sub) => <SubConversation model={sub} ctx={base} />;
    return base;
  }, []);

  const { rewind, fork } = userActionsForStatus(status);
  const actions = React.useMemo<BubbleActions>(() => ({
    canRewind: rewind,
    canFork: fork,
    onRewind: (i, t) => void rewindActiveSession(i, t),
    onFork: (i, t) => void forkActiveSession(i, t),
    resolveAttachmentUrl: (filename) =>
      activeId && filename ? `/api/instances/${encodeURIComponent(activeId)}/attachments/${encodeURIComponent(filename)}` : null,
  }), [rewind, fork, activeId]);

  // Stick to the bottom while the reader is there; leave them alone otherwise.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && sticky.current) el.scrollTop = el.scrollHeight;
  }, [rev]);

  // A new session starts at the bottom.
  React.useLayoutEffect(() => {
    sticky.current = true;
    setAtBottom(true);
  }, [activeId]);

  // Register the viewport the lazy pager measures and splices against.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lazyHistory.setViewport({
      clientHeight: () => el.clientHeight,
      scrollHeight: () => el.scrollHeight,
      preserve: (fn) => {
        const prevTop = el.scrollTop;
        const prevHeight = el.scrollHeight;
        fn();
        // React commits synchronously on the next flush; restore after layout.
        requestAnimationFrame(() => { el.scrollTop = prevTop + (el.scrollHeight - prevHeight); });
      },
    });
    return () => lazyHistory.setViewport(null);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !listRef.current || !pinRef.current) return;
    const detach = stickyPrompt.attach(el, listRef.current, pinRef.current);
    const untrack = trackSwipes(pinRef.current, () => stickyPrompt.reveal(), () => stickyPrompt.conceal());
    return () => { detach(); untrack(); };
  }, []);

  React.useEffect(() => { stickyPrompt.refresh(); }, [rev, activeId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    sticky.current = near;
    if (near !== atBottom) setAtBottom(near);
    if (el.scrollTop < 200) void lazyHistory.loadEarlier();
  };

  const isEmpty = conversation.items.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cn('h-full overflow-y-auto overscroll-contain', showCallUsage ? 'show-call-usage' : 'hide-call-usage')}
        data-conversation
      >
        <div ref={listRef} className="mx-auto w-full max-w-3xl space-y-6 px-4 pt-6 pb-10 md:px-6">
          {lazy.visible && (
            <button
              type="button"
              onClick={() => void lazyHistory.loadEarlier()}
              className="mx-auto flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground shadow-xs hover:text-foreground"
            >
              {lazy.loading ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <HistoryIcon className="size-3.5" />}
              {lazy.loading ? 'Loading earlier messages…' : 'Earlier messages'}
            </button>
          )}
          {isEmpty && !lazy.loading ? empty : <ItemsList model={conversation} rev={rev} ctx={ctx} actions={actions} />}
        </div>
      </div>
      <div
        ref={pinRef}
        hidden={pin.kind === 'hidden'}
        role={pin.kind === 'pinned' ? 'button' : 'status'}
        tabIndex={pin.kind === 'pinned' ? 0 : undefined}
        title={pin.kind === 'pinned' ? 'Jump to this prompt' : undefined}
        onClick={() => stickyPrompt.jumpToPinned()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stickyPrompt.jumpToPinned(); } }}
        className="absolute inset-x-0 top-0 z-10 cursor-pointer touch-pan-x touch-pinch-zoom px-4 md:px-6"
        style={pin.kind === 'pinned' && pin.shift ? { transform: `translateY(${pin.shift}px)` } : undefined}
        data-pinned-prompt
      >
        <div className="mx-auto max-w-3xl pt-2">
          {pin.kind === 'status' ? (
            <div className="rounded-xl border bg-card/95 px-4 py-2 text-center text-xs text-muted-foreground shadow-md backdrop-blur">{pin.text}</div>
          ) : pin.kind === 'pinned' ? (
            <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-background/90 shadow-md ring-1 ring-primary/20 backdrop-blur">
              <div
                data-pin-body
                className={cn('md max-h-24 overflow-hidden rounded-2xl rounded-br-md bg-primary/10 px-4 py-2.5', pin.overflowing && '[mask-image:linear-gradient(to_bottom,black_60%,transparent)]')}
                dangerouslySetInnerHTML={{ __html: pin.html }}
              />
            </div>
          ) : null}
        </div>
      </div>
      {!atBottom && (
        <Button
          size="icon-sm"
          variant="secondary"
          className="absolute right-1/2 bottom-3 translate-x-1/2 rounded-full shadow-md"
          aria-label="Jump to latest"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
}
