// Who owns a conducted worker, as the web UI can tell it: the header's owner chip and Alt+ArrowUp,
// and the composer's accent, placeholder and first-send check, all read one resolution.
import { useMemo } from 'react';
import { useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { CONDUCT_PROJECT, deriveConductors, ownerLabel } from '@shared/conductors';
import { selectInstance } from '@/app/controller';
import { resumeSession } from '@/app/sessionActions';
import { promptSendable } from '@/features/composer/send';

/** How the owner is reached: selected when it has a listed instance, resumed when it is a listed inactive conductor. */
export type OwnerTarget = { kind: 'select'; instanceId: string } | { kind: 'resume-conductor' };
export type WorkerOwner =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'owned'; sessionId: string; label: string; instance: Instance | null; target: OwnerTarget | null };

const NONE: WorkerOwner = { kind: 'none' };

export function workerOwnerOf(inst: Instance, { instances, conductRows }: { instances: readonly Instance[]; conductRows: readonly any[] }): WorkerOwner {
  if (!inst.conducted || inst.project === CONDUCT_PROJECT) return NONE;
  const sessionId = inst.ownerSessionId;
  if (!sessionId) return { kind: 'unknown' };
  const conductors = deriveConductors({ conductRows, instances });
  const label = ownerLabel(sessionId, { conductors, instances });
  const instance = instances.find((i) => i.sessionId === sessionId) ?? null;
  const target: OwnerTarget | null = instance
    ? { kind: 'select', instanceId: instance.id }
    : conductors.inactive.some((c) => c.sessionId === sessionId) ? { kind: 'resume-conductor' } : null;
  return { kind: 'owned', sessionId, label, instance, target };
}

/** Why a prompt cannot go to the owner now, or null when it can (idle, or mid-turn as a steer). */
export function ownerSendBlock(owner: WorkerOwner): string | null {
  if (owner.kind !== 'owned') return null;
  const { instance, label } = owner;
  if (!instance) return `${label} isn't running`;
  if (promptSendable(instance)) return null;
  if (instance.modelSwitch) return `${label} is switching model`;
  if (instance.overageStoppedUnarmed) return `${label} is stopped for overage`;
  return instance.status === 'spawning' ? `${label} is starting` : `${label} isn't running`;
}

export function useWorkerOwner(inst: Instance | null): WorkerOwner {
  const instances = useStore(appStore, (s) => s.instances);
  const conductRows = useStore(appStore, (s) => s.conductSessions);
  return useMemo(() => (inst ? workerOwnerOf(inst, { instances, conductRows }) : NONE), [inst, instances, conductRows]);
}

/** Takes the user to the owner: the same navigation as its sidebar row, pushed so Back returns to the worker. */
export function openOwner(owner: WorkerOwner): void {
  if (owner.kind !== 'owned' || !owner.target) return;
  if (owner.target.kind === 'select') selectInstance(owner.target.instanceId, { push: true, userGesture: true });
  else void resumeSession({ projectName: CONDUCT_PROJECT, worktreeName: null, sessionId: owner.sessionId });
}

/** Where Alt+ArrowUp belongs to the widget focused, not to this shortcut. */
const OWN_KEYS = '[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=combobox], select';

export function isBackToOwnerKey(e: KeyboardEvent): boolean {
  if (e.key !== 'ArrowUp' || !e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return false;
  if (e.defaultPrevented || e.repeat || e.isComposing) return false;
  return !(e.target instanceof Element && e.target.closest(OWN_KEYS));
}
