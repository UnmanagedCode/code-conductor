// The platform selection point — the only place `process.platform` is read.

import type { Platform } from './platform.ts';
import { posixPlatform } from './posix.ts';
import { win32Platform } from './win32.ts';

export type { Platform, PlatformCapabilities, SpawnRole, KillSignal, ChildHandle } from './platform.ts';
export { posixPlatform, win32Platform };

export function selectPlatform(os: NodeJS.Platform): Platform {
  if (os === 'win32') return win32Platform;
  return posixPlatform;
}

export const hostPlatform: Platform = selectPlatform(process.platform);

export function samePath(a: string, b: string, platform: Platform = hostPlatform): boolean {
  return platform.pathKey(a) === platform.pathKey(b);
}
