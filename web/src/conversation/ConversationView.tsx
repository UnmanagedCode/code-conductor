import * as React from 'react';
import { ArrowDownIcon, LoaderCircleIcon, HistoryIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { followViewLink } from '@/components/viewLinks';
import { useStore } from '@/state/createStore';
import { appStore, activeInstance } from '@/state/app';
import { conversation, lazyHistory, stickyPrompt } from '@/app/controller';
import { pinStore, trackSwipes } from './stickyPrompt';
import { forkActiveSession, forkRenewal, rewindActiveSession, rewindRenewal } from '@/app/sessionActions';
import { peekTaskTracker } from '@/app/trackers';
import { uiStore } from '@/app/ui';
import { useSessionColumn } from '@/app/sessionWidth';
import { ItemsList, USER_BUBBLE, USER_TONE_PROMPT, type BubbleActions } from './items';
import { userActionsForStatus, type ConversationModel } from './model';
import type { RenderCtx } from './tools';
import { cn } from '@/lib/utils';

/** Side padding of the transcript list and the sticky-pin column. Each carries it inside its own width cap, so their content boxes, and the user bubbles in them, line up. */
const TRANSCRIPT_PAD_X = 'px-3 md:px-6';
/** Closer than this to the bottom, "Jump to latest" stays hidden. */
const NEAR_BOTTOM_PX = 50;
/** Within this of the bottom (or past it, in an overscroll bounce), the reader is at the bottom and following re-arms. */
const AT_BOTTOM_PX = 2;

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
  const column = useSessionColumn();
  const pin = useStore(pinStore, (s) => s.pin);
  const gutter = useStore(pinStore, (s) => s.gutter);
  const follow = React.useRef(true);
  const touching = React.useRef(false);
  /** A frame's write the touch gate skipped, for the lift to replay. */
  const heldBack = React.useRef(false);
  const seen = React.useRef({ top: 0, height: 0, client: 0 });
  const shownClears = React.useRef(conversation.clears);
  const [nearBottom, setNearBottom] = React.useState(true);

  const activeId = inst?.id ?? null;
  // An ended pane has no instance to serve its attachments: they are addressed by session.
  const attachmentBase = inst?.ended && inst.sessionId
    ? `/api/sessions/${encodeURIComponent(inst.sessionId)}/attachments/`
    : activeId ? `/api/instances/${encodeURIComponent(activeId)}/attachments/` : null;
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
    onRewindRenewal: (s) => void rewindRenewal(s),
    onForkRenewal: (s) => void forkRenewal(s),
    resolveAttachmentUrl: (filename) =>
      attachmentBase && filename ? attachmentBase + encodeURIComponent(filename) : null,
  }), [rewind, fork, attachmentBase]);

  const fromBottom = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;
  const observe = (el: HTMLElement) => { seen.current = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }; };
  const syncNear = (el: HTMLElement) => setNearBottom(fromBottom(el) < NEAR_BOTTOM_PX);
  const toBottom = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    heldBack.current = false;
    observe(el);
    setNearBottom(true);
  };

  // Follow the tail while the reader is at the bottom: any move up stops it, and only the very bottom or Jump to
  // latest resumes it. Nothing is written while a finger is down. A cleared transcript (another session, a rewind,
  // a reconnect) starts at the bottom again.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (conversation.clears !== shownClears.current) {
      shownClears.current = conversation.clears;
      follow.current = true;
    }
    if (!el) return;
    if (follow.current && !touching.current) return toBottom(el);
    if (follow.current) heldBack.current = true;
    // Growth below is recorded as it renders, never the position (a finger's move may not have reported yet), so a
    // later shrink above is measured against the tallest content since the last observed position.
    seen.current.height = Math.max(seen.current.height, el.scrollHeight);
    syncNear(el);
  }, [rev]);

  // Mounting onto the transcript the reader left scrolled up (a full-page view closing) resumes their place.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !leftAt || leftAt.clears !== conversation.clears) return;
    follow.current = false;
    el.scrollTop = leftAt.top;
    observe(el);
    syncNear(el);
  }, []);

  // Nothing is written while a finger is on the transcript: on iOS a scrollTop write cuts a live touch scroll off.
  // The gate opens when the last touch anywhere ends: a touch event goes to where its finger started, so a second
  // finger lifting off the pin, Jump to latest or the composer never reaches the transcript.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const down = () => { touching.current = true; };
    const up = (e: TouchEvent) => {
      if (!touching.current || e.touches.length > 0) return;
      touching.current = false;
      // Lifting replays the write the gate held back, if the reader is still following; it closes no other gap.
      if (follow.current && heldBack.current) toBottom(el);
      else syncNear(el);
      heldBack.current = false;
    };
    el.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchend', up, { passive: true });
    window.addEventListener('touchcancel', up, { passive: true });
    return () => {
      el.removeEventListener('touchstart', down);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
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
        // React commits synchronously on the next flush; restore after layout. The one write gated on neither a
        // finger nor following: it keeps the content under the reader still as a page lands above (gating it would
        // jump the content a page under the finger), and it only moves the position down, never reading as a move up.
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

  React.useEffect(() => { stickyPrompt.refresh(); }, [rev, activeId, column['data-session-width']]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const prev = seen.current;
    // A drop from content shrinking or the viewport growing back is the browser's clamp or anchoring, not the reader.
    const shrink = Math.max(0, prev.height - el.scrollHeight) + Math.max(0, el.clientHeight - prev.client);
    // At the bottom first: an iOS bottom bounce (past the bottom, easing back) re-arms rather than disarms.
    if (fromBottom(el) <= AT_BOTTOM_PX) follow.current = true;
    else if (top < prev.top - 1 - shrink) follow.current = false;
    observe(el);
    leftAt = follow.current ? null : { clears: conversation.clears, top };
    syncNear(el);
    if (top < 200) void lazyHistory.loadEarlier();
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
        <div ref={listRef} {...column} className={`mx-auto w-full space-y-6 pt-6 pb-10 ${TRANSCRIPT_PAD_X}`}>
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
        onClick={(e) => { if (!e.defaultPrevented) stickyPrompt.jumpToPinned(); }}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !(e.target as Element).closest('a')) { e.preventDefault(); stickyPrompt.jumpToPinned(); } }}
        className={cn('absolute left-0 top-0 z-10 touch-pan-x touch-pinch-zoom', pin.kind === 'pinned' ? 'cursor-pointer' : 'cursor-default')}
        style={{ right: gutter, ...(pin.kind === 'pinned' && pin.shift ? { transform: `translateY(${pin.shift}px)` } : {}) }}
        data-pinned-prompt
      >
        <div {...column} className={cn('mx-auto pt-2', TRANSCRIPT_PAD_X)}>
          {pin.kind === 'status' ? (
            <div className="rounded-xl border bg-card/95 px-4 py-2 text-center text-xs text-muted-foreground shadow-md backdrop-blur">{pin.text}</div>
          ) : pin.kind === 'pinned' ? (
            <div className={cn('rounded-l-2xl rounded-r-md bg-background/90 shadow-md ring-1 ring-primary/20 backdrop-blur')}>
              <div
                data-pin-body
                onClick={followViewLink}
                className={cn('md max-h-[calc(5lh_+_1.25rem)] overflow-hidden', USER_BUBBLE, USER_TONE_PROMPT, pin.overflowing && '[mask-image:linear-gradient(to_bottom,black_calc(100%_-_1.5lh),transparent)]')}
                dangerouslySetInnerHTML={{ __html: pin.html }}
              />
            </div>
          ) : null}
        </div>
      </div>
      {!nearBottom && (
        <Button
          size="icon-sm"
          variant="secondary"
          className="absolute right-1/2 bottom-3 translate-x-1/2 rounded-full shadow-md"
          aria-label="Jump to latest"
          onClick={() => {
            // Re-armed here, not on landing: a smooth scroll's destination is fixed when it starts, so
            // under a growing transcript it lands short of the bottom; the next frame's write takes over.
            follow.current = true;
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
