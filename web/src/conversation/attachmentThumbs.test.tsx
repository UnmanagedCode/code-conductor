/// <reference types="node" />
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { conversation } from '@/app/controller';
import { ConversationView } from './ConversationView';
import { serverModules } from './testkit';
import { flush } from './renderModel';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

afterEach(() => {
  act(() => {
    conversation.clear();
    appStore.set({ activeId: null, instances: [] });
  });
});

const ID = 'inst-attach-7';

function mountActive() {
  appStore.set({ activeId: ID, instances: [{ id: ID, status: 'idle' } as any] });
  return render(<TooltipProvider><ConversationView /></TooltipProvider>);
}

const thumbs = (c: HTMLElement) => [...c.querySelectorAll('[data-conversation] img')] as HTMLImageElement[];

describe('user bubble attachment thumbnails', () => {
  it('a live image attachment shows its thumbnail from the in-memory bytes', async () => {
    // Invariant: a live attachment carrying base64 renders as an image whose source is a data URL of those exact bytes; a non-image attachment renders no thumbnail.
    const r = mountActive();
    act(() => {
      conversation.apply({ kind: 'user_echo', text: 'look', userIndex: 0, attachments: [
        { kind: 'image', mediaType: 'image/jpeg', dataBase64: 'QUJDREVG', name: 'shot.jpg' },
        { kind: 'file', name: 'notes.txt', path: '/p/notes.txt' },
      ] } as any);
    });
    await flush();
    const imgs = thumbs(r.container);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('data:image/jpeg;base64,QUJDREVG');
    expect(r.container.textContent).toContain('notes.txt');
  });

  it('a replayed image marker line shows a thumbnail served from the instance attachments route', async () => {
    // Invariant: on replay the server's parser yields only a filename; the thumbnail loads from /api/instances/<active id>/attachments/<filename>.
    const marker = 'Attached file: `/data/.code-conductor/proj/attachments/pic 9.png`';
    const events = S.replayPersistedLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: `see this\n${marker}` }] } });
    const echo = events.find((e: any) => e.kind === 'user_echo') as any;
    expect(echo.attachments[0]).toMatchObject({ kind: 'image', filename: 'pic 9.png' });
    expect(echo.attachments[0].dataBase64).toBeUndefined();
    const r = mountActive();
    act(() => { for (const e of events) conversation.apply({ ...e, _seq: 1 }); });
    await flush();
    const imgs = thumbs(r.container);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe(`/api/instances/${ID}/attachments/${encodeURIComponent('pic 9.png')}`);
  });

  it('with no active session a replayed attachment has no route to load from, so no thumbnail', async () => {
    // Invariant: control: the route URL is built from the active id; without one the bubble shows no image.
    const events = S.replayPersistedLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'x\nAttached file: `/d/.code-conductor/p/attachments/a.png`' }] } });
    const r = render(<TooltipProvider><ConversationView /></TooltipProvider>);
    act(() => { for (const e of events) conversation.apply({ ...e, _seq: 1 }); });
    await flush();
    expect(thumbs(r.container)).toHaveLength(0);
  });
});
