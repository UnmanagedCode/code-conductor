// M6 — THE TWO-HANDLE PREMISE, COUNTED OFF A REAL TURN'S TRACE.
//
//   node tests/fuse-trace-count.mjs <trace.log> [<trace.log> …]
//
// NOT a `*.test.mjs`, so `tests/run.mjs`'s discovery never picks it up: it is
// an instrument, like `fuse-transport-bench.mjs`. It asserts nothing. It
// reports three counts off a `CC_FUSE_TRACE=1` capture, which is what turns the
// two-handle premise from an argument into a standing condition with a check
// (src/systems/fuse/PROVENANCE.md → D13c).
//
// THE LINE SHAPE is `union.c`'s `tr()`:
//   <op>\t<path>\ttier=<t> cflags=<n> pid=… tgid=… mark=… exe=… cmd=…
//
// WHAT `cflags` BUYS, and it is the whole reason the field exists: `open` at
// `cflags & 0x02` is a WRITE open and `cflags == 0` is a read one. Without it
// every count below would be reads and writes together, i.e. an upper bound
// reported as a measurement.
//
// WHAT THIS CANNOT SEE, stated rather than left for a reader to assume: `tr()`
// records no TIMESTAMP and `release` is not traced, so a write-open's WINDOW is
// not in the capture. So the overlap question is answered STRUCTURALLY instead,
// and the answer is complete exactly when the count allows it:
//
//   if no path has more than ONE write-open in the whole capture, then no two
//   write-opens of one path can overlap, whatever their windows were.
//
// A path with two or more is reported by name WITHOUT a verdict — that is the
// case a later instrument has to time, and inventing an ordering here would be
// the thing this file exists not to do.

import { promises as fs } from 'node:fs';

const FOR_WRITE = 0x02;
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tests/fuse-trace-count.mjs <trace.log> [<trace.log> …]');
  process.exit(2);
}

for (const file of files) {
  const text = await fs.readFile(file, 'utf8');
  const markedTgids = new Set();
  const allTgids = new Set();
  const writeOpens = new Map();   // project-tier path → count
  const byExe = new Map();        // marked tgid → its exe, for the population report
  let lines = 0, noCflags = 0;

  for (const line of text.split('\n')) {
    if (line === '') continue;
    lines++;
    const [op, p, rest = ''] = line.split('\t');
    const tgid = /\btgid=(-?\d+)/.exec(rest)?.[1];
    const mark = /\bmark=(\d+)/.exec(rest)?.[1];
    const tier = /\btier=(\S+)/.exec(rest)?.[1];
    const cflags = /\bcflags=(\d+)/.exec(rest)?.[1];
    if (cflags === undefined) { noCflags++; continue; }
    if (tgid) allTgids.add(tgid);
    if (mark === '1' && tgid) {
      markedTgids.add(tgid);
      byExe.set(tgid, /\bexe=(\S+)/.exec(rest)?.[1] ?? '?');
    }
    if (tier !== 'project') continue;
    if (op !== 'open' && op !== 'create') continue;
    if ((Number(cflags) & FOR_WRITE) === 0) continue;
    writeOpens.set(p, (writeOpens.get(p) ?? 0) + 1);
  }

  const repeated = [...writeOpens].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  console.log(`\n=== ${file}`);
  console.log(`lines=${lines}  lines with no cflags field=${noCflags}`
    + `${noCflags ? '  ← an OLD capture: every count below is unreliable' : ''}`);
  console.log(`distinct TGIDs seen=${allTgids.size}  MARKED=${markedTgids.size}`);
  for (const [tgid, exe] of byExe) console.log(`  marked tgid ${tgid}  exe=${exe}`);
  console.log(`project-tier paths write-opened=${writeOpens.size}`
    + `  total write-opens=${[...writeOpens.values()].reduce((a, b) => a + b, 0)}`);
  if (repeated.length === 0) {
    console.log('paths write-opened MORE THAN ONCE: none'
      + ' — so NO TWO WRITE-OPENS OF ONE PATH CAN OVERLAP in this capture,'
      + ' structurally and without needing their windows.');
  } else {
    console.log(`paths write-opened MORE THAN ONCE: ${repeated.length}`
      + ' — this capture CANNOT decide whether they overlapped (no timestamps, `release` untraced).'
      + ' Timing them needs a wider instrument:');
    for (const [p, n] of repeated.slice(0, 20)) console.log(`  ${n}×  ${p}`);
  }
}
