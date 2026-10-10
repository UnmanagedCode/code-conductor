// App-wide confirmation dialog and toasts — the designed replacements for the
// browser's confirm() / alert(). `confirmDialog` resolves true/false; toasts
// come from sonner (<Toaster/> is mounted once in App).
import * as React from 'react';
import { toast as sonnerToast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createStore, useStore } from '@/state/createStore';

export type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
const confirmStore = createStore<{ pending: Pending | null }>({ pending: null });

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    confirmStore.get().pending?.resolve(false);
    confirmStore.set({ pending: { ...opts, resolve } });
  });
}

function settle(ok: boolean) {
  const p = confirmStore.get().pending;
  confirmStore.set({ pending: null });
  p?.resolve(ok);
}

export function ConfirmHost() {
  const pending = useStore(confirmStore, (s) => s.pending);
  return (
    <Dialog open={!!pending} onOpenChange={(o) => { if (!o) settle(false); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{pending?.title}</DialogTitle>
          {pending?.description && (
            <DialogDescription asChild={typeof pending.description !== 'string'}>
              {typeof pending.description === 'string'
                ? <span className="whitespace-pre-line">{pending.description}</span>
                : <div>{pending.description}</div>}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle(false)}>{pending?.cancelLabel ?? 'Cancel'}</Button>
          <Button variant={pending?.destructive ? 'destructive' : 'default'} onClick={() => settle(true)} autoFocus>
            {pending?.confirmLabel ?? 'Continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const toast = {
  success: (title: string, description?: string) => sonnerToast.success(title, { description }),
  error: (title: string, description?: string) => sonnerToast.error(title, { description, duration: 8000 }),
  info: (title: string, description?: string) => sonnerToast(title, { description }),
  warning: (title: string, description?: string) => sonnerToast.warning(title, { description, duration: 8000 }),
};
