import { CircleAlertIcon } from 'lucide-react';

export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}
