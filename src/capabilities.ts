// Refusal codes and helpers for the features a host platform can turn off
// (`Platform.capabilities`). One home, so every gate refuses the same way.

import type express from 'express';
import { httpError } from './httpError.ts';
import { LOCAL_SYSTEM_ID } from './systems/localSystem.ts';
import { FUSE_UNAVAILABLE } from './systems/fuse/preflight.ts';
import type { PlatformCapabilities } from './platform/platform.ts';

export const SYSTEMS_UNAVAILABLE = 'SYSTEMS_UNAVAILABLE';
export const VOICE_UNAVAILABLE = 'VOICE_UNAVAILABLE';

const REFUSALS: Record<keyof PlatformCapabilities, { code: string; feature: string }> = {
  remoteSystems: { code: SYSTEMS_UNAVAILABLE, feature: 'remote Systems are' },
  fuseUnion: { code: FUSE_UNAVAILABLE, feature: 'the FUSE-union chroot is' },
  voice: { code: VOICE_UNAVAILABLE, feature: 'voice is' },
};

export function capabilityRefusal(cap: keyof PlatformCapabilities): Error & { statusCode: number } {
  const { code, feature } = REFUSALS[cap];
  return httpError(501, `${feature} not available on this platform`, { code });
}

// adopt's soft-refusal shape: a 200 body the caller renders inline.
export function capabilitySoftRefusal(cap: keyof PlatformCapabilities): { ok: false; code: string; reason: string } {
  const { code, feature } = REFUSALS[cap];
  return { ok: false, code, reason: `${feature} not available on this platform` };
}

export function requireCapability(caps: PlatformCapabilities, cap: keyof PlatformCapabilities): express.RequestHandler {
  return (_req, _res, next) => next(caps[cap] ? undefined : capabilityRefusal(cap));
}

// A placement on a non-local system while this host cannot run remote Systems.
export function remotePlacementRefused(caps: PlatformCapabilities, system: unknown): boolean {
  return !caps.remoteSystems && system !== undefined && system !== null && system !== '' && system !== LOCAL_SYSTEM_ID;
}
