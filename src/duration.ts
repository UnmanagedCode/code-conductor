// The compact duration renderer for agent/conductor-facing text.
//
// Conductors read timeout strings like the heartbeat's "did NOT finish" stub;
// a raw millisecond integer there makes them divide by 60000 to learn how long
// they waited. This renders `h`/`m`/`s`, largest component first, no spaces,
// zero components dropped, and never `ms`:
//
//   1800000 → 30m      5400000 → 1h30m     7200000 → 2h
//   3661000 → 1h1m1s     90000 → 1m30s       45000 → 45s
//      1999 → 1s          (truncated to whole seconds — never over-report a window)
//       150 → <1s         (sub-second: ms are never shown)
//   0 / negative / non-finite → 0s
//
// Distinct from `public/usage.js`'s `formatDuration`, which is UI-only: spaced,
// capped at two components, and `—` for null. The two contracts stay separate.
export function humanizeDuration(ms: number): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '0s';
  const total = Math.floor(ms / 1000);
  if (total === 0) return '<1s';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [
    h ? `${h}h` : '',
    m ? `${m}m` : '',
    s ? `${s}s` : '',
  ].join('');
}
