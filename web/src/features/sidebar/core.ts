// Typed views of the DOM-free derivations in lib/core (plain JS, whose
// destructured defaults would otherwise infer as never[]).
import * as conductors from '@shared/conductors';
import * as needsYou from '@shared/needsYou';
import * as unread from '@shared/unreadMarks';
import type { Instance } from '@/state/types';

type AnyRow = Record<string, any>;
export type ConductorsSplit = { live: AnyRow[]; inactive: AnyRow[] };
type StripEntry = AnyRow & { autoResumeAt: number | null; queuedCount: number };
export type StripGroups = { waiting: StripEntry[]; running: StripEntry[]; finished: StripEntry[] };

export const deriveConductors = conductors.deriveConductors as (a: { conductRows?: AnyRow[]; instances?: Instance[] }) => ConductorsSplit;
export const conductorChips = conductors.conductorChips as (a: { workers: Instance[]; spawned?: AnyRow[]; registered: Set<string> }) => { project: string; live: boolean; worktrees: string[] }[];
export const ownerLabel = conductors.ownerLabel as (sid: string, a: { conductors?: ConductorsSplit; instances?: Instance[] }) => string;
export const ownersByPlace = conductors.ownersByPlace as (instances: Instance[]) => Map<string, Set<string>>;
export const deriveStrip = needsYou.deriveStrip as (a: { conductors?: AnyRow[]; instances?: Instance[] }) => StripGroups;
export const unreadBySession = unread.unreadBySession as (a: { instances?: AnyRow[]; rows?: AnyRow[] }) => Map<string, number>;
