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
import { SESSION_COLUMN_MAX_W, sessionWidthStore } from '@/app/sessionWidth';
import { ItemsList, USER_BUBBLE_MAX_W, type BubbleActions } from './items';
import { userActionsForStatus, type ConversationModel } from './model';
import type { RenderCtx } from './tools';
import { cn } from '@/lib/utils';

/** Side padding shared by the transcript list and the sticky-pin overlay, which must stay aligned. */
const TRANSCRIPT_PAD_X = 'px-3 md:px-6';

/**
 * Where the reader left the transcript scrolled up, while `conversation.clears` still reads `clears`.
 * Module state, so a full-page view unmounting the view keeps it; null while they are at the bottom.
 */
let leftAt: { clears: number; top: number } | null = null;

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
  const preset = useStore(sessionWidthStore, (s) => s.preset);
  const pin = useStore(pinStore, (s) => s.pin);
  const gutter = useStore(pinStore, (s) => s.gutter);
  const sticky = React.useRef(true);
  const shownClears = React.useRef(conversation.clears);
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

  // Stick to the bottom while the reader is there; leave them alone otherwise. A cleared
  // transcript (another session, a rewind, a reconnect) starts at the bottom again.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (conversation.clears !== shownClears.current) {
      shownClears.current = conversation.clears;
      sticky.current = true;
      setAtBottom(true);
    }
    if (el && sticky.current) el.scrollTop = el.scrollHeight;
  }, [rev]);

  // Mounting onto the transcript the reader left scrolled up (a full-page view closing) resumes their place.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !leftAt || leftAt.clears !== conversation.clears) return;
    sticky.current = false;
    setAtBottom(false);
    el.scrollTop = leftAt.top;
  }, []);

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

  React.useEffect(() => { stickyPrompt.refresh(); }, [rev, activeId, preset]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    sticky.current = near;
    leftAt = near ? null : { clears: conversation.clears, top: el.scrollTop };
    if (near !== atBottom) setAtBottom(near);
    if (el.scrollTop < 200) void lazyHistory.loadEarlier();
  };

  const isEmpty = conversation.items.length === 0;

  return (
    // Clipped: a pin shifted up past the transcript's top must not cover the header.
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain"
        data-call-usage={showCallUsage ? 'shown' : 'hidden'}
        data-conversation
      >
        <div ref={listRef} data-session-width={preset} className={`mx-auto w-full ${SESSION_COLUMN_MAX_W[preset]} space-y-6 pt-6 pb-10 ${TRANSCRIPT_PAD_X}`}>
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
        hidden={pin.kind === 'hidden' || (pin.kind === 'pinned' && pin.pushedOff)}
        role={pin.kind === 'pinned' ? 'button' : 'status'}
        tabIndex={pin.kind === 'pinned' ? 0 : undefined}
        title={pin.kind === 'pinned' ? 'Jump to this prompt' : undefined}
        onClick={() => stickyPrompt.jumpToPinned()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stickyPrompt.jumpToPinned(); } }}
        className={cn('absolute left-0 top-0 z-10 touch-pan-x touch-pinch-zoom', TRANSCRIPT_PAD_X, pin.kind === 'pinned' ? 'cursor-pointer' : 'cursor-default')}
        style={{ right: gutter, ...(pin.kind === 'pinned' && pin.shift ? { transform: `translateY(${pin.shift}px)` } : {}) }}
        data-pinned-prompt
      >
        <div data-session-width={preset} className={cn('mx-auto pt-2', SESSION_COLUMN_MAX_W[preset])}>
          {pin.kind === 'status' ? (
            <div className="rounded-xl border bg-card/95 px-4 py-2 text-center text-xs text-muted-foreground shadow-md backdrop-blur">{pin.text}</div>
          ) : pin.kind === 'pinned' ? (
            <div className={`ml-auto ${USER_BUBBLE_MAX_W} rounded-2xl rounded-br-md bg-background/90 shadow-md ring-1 ring-primary/20 backdrop-blur`}>
              <div
                data-pin-body
                className={cn('md max-h-[calc(5lh_+_1.25rem)] overflow-hidden rounded-2xl rounded-br-md bg-primary/10 px-4 py-2.5', pin.overflowing && '[mask-image:linear-gradient(to_bottom,black_calc(100%_-_1.5lh),transparent)]')}
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
