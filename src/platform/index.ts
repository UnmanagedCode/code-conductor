// The platform selection point — the only place `process.platform` is read.

import type { Platform } from './platform.ts';
import { posixPlatform } from './posix.ts';

export type { Platform, PlatformCapabilities, SpawnRole, KillSignal, ChildHandle } from './platform.ts';
export { posixPlatform };

export function selectPlatform(os: NodeJS.Platform): Platform {
  if (os === 'win32') throw new Error('no Platform implementation for win32');
  return posixPlatform;
}

export const hostPlatform: Platform = selectPlatform(process.platform);

export function samePath(a: string, b: string, platform: Platform = hostPlatform): boolean {
  return platform.pathKey(a) === platform.pathKey(b);
}
