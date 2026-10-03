import type { Platform } from './platform.ts';

export const posixPlatform: Platform = {
  capabilities: { remoteSystems: true, fuseUnion: true, voice: true },
  commandFor(spec) {
    return 'shell' in spec
      ? { command: 'bash', args: ['-lc', spec.shell] }
      : { command: spec.argv[0], args: spec.argv.slice(1) };
  },
  spawnOptions(role) {
    return role === 'child' ? {} : { detached: true };
  },
  killProcess(target, signal) {
    if (typeof target === 'number') process.kill(target, signal);
    else target.kill(signal);
  },
  killGroup(pid, signal) {
    process.kill(-pid, signal);
  },
  splitCommand(line) {
    return line.split(/\s+/).filter(Boolean);
  },
  pathKey(p) {
    return p;
  },
};
