// What both platforms' root-lock endpoints share (src/rootLock.ts).
import { createHash } from 'node:crypto';

// The longest socket path both kernels bind: macOS's `sun_path` holds 104
// bytes with the NUL, Linux's 108. A longer path is reached another way.
export const SOCK_PATH_MAX = 103;

// The lock dir's identity in a machine-global name (a pipe or a tmp socket).
export function lockDirHash(realLockDir: string): string {
  return createHash('sha256').update(realLockDir).digest('hex').slice(0, 16);
}

export const NO_RELEASE = (): void => {};
