import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { NotifyToggle, notifyToggleState } from './NotifyToggle';
import { notificationStore } from './notifications';

describe('NotifyToggle', () => {
  it('explains each state', () => {
    expect(notifyToggleState('granted', true)).toMatchObject({ on: true, blocked: false });
    expect(notifyToggleState('granted', false)).toMatchObject({ on: false, title: 'Notifications off. Click to turn on.' });
    expect(notifyToggleState('denied', false).title).toMatch(/blocked/);
    expect(notifyToggleState('unsupported', false)).toMatchObject({ blocked: true });
  });

  it('reflects the store', () => {
    notificationStore.set({ permission: 'default', globalEnabled: false });
    render(<TooltipProvider><NotifyToggle /></TooltipProvider>);
    const btn = screen.getByRole('button', { name: 'Turn notifications on' });
    expect(btn.dataset.notify).toBe('off');
    act(() => notificationStore.set({ permission: 'granted', globalEnabled: true }));
    expect(screen.getByRole('button', { name: 'Turn notifications off' }).dataset.notify).toBe('on');
    act(() => notificationStore.set({ permission: 'denied', globalEnabled: false }));
    expect(screen.getByRole('button').dataset.notify).toBe('blocked');
  });
});
