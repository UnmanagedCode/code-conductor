// Test helper: render a ConversationModel's items the way ConversationView
// does, re-rendering on every model notification.
import * as React from 'react';
import { act, render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ItemsList, type BubbleActions } from './items';
import type { ConversationModel } from './model';
import type { RenderCtx } from './tools';

function View({ model, actions }: { model: ConversationModel; actions: BubbleActions | null }) {
  const rev = React.useSyncExternalStore(model.subscribe, model.getRev, model.getRev);
  const ctx = React.useMemo<RenderCtx>(() => {
    const base: RenderCtx = { model, describeCtx: {}, renderSub: () => null };
    base.renderSub = (sub) => <SubView sub={sub} ctx={base} />;
    return base;
  }, [model]);
  return <div data-testid="root"><ItemsList model={model} rev={rev} ctx={ctx} actions={actions} /></div>;
}

function SubView({ sub, ctx }: { sub: ConversationModel; ctx: RenderCtx }) {
  const subCtx = React.useMemo<RenderCtx>(() => ({ ...ctx, model: sub }), [ctx, sub]);
  return <ItemsList model={sub} rev={sub.rev} ctx={subCtx} actions={null} />;
}

export const noActions: BubbleActions = {
  canRewind: true, canFork: true, onRewind: () => {}, onFork: () => {}, resolveAttachmentUrl: () => null,
};

export function renderModel(model: ConversationModel, actions: BubbleActions | null = noActions) {
  const r = render(<TooltipProvider><View model={model} actions={actions} /></TooltipProvider>);
  return { ...r, root: r.container.querySelector('[data-testid="root"]') as HTMLElement };
}

/** Let queued model notifications flush and React commit. */
export async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
