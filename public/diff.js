// Tiny line-diff for the Edit / Write / NotebookEdit renderers.
// Uses Myers' algorithm (in its simple O((N+M)*D) form) on line arrays
// to produce a sequence of {op: '=' | '-' | '+', text} entries.
//
// `op === '='` means equal context, `'-'` deleted from the old side, `'+'`
// added on the new side. Returned in interleaved order ready for a
// unified-diff style render.

export function lineDiff(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  // Strip trailing empty line from trailing newline split so it doesn't
  // pollute diffs.
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();

  const N = a.length, M = b.length;
  if (N === 0 && M === 0) return [];

  // Compute shortest edit script via Myers'.
  const max = N + M;
  const v = new Map();
  v.set(1, 0);
  const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    const snapshot = new Map(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let x;
      const down = !v.has(k - 1) || (v.has(k + 1) && v.get(k - 1) < v.get(k + 1));
      if (down) x = v.get(k + 1) ?? 0;
      else x = (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= N && y >= M) { done = true; break; }
    }
  }

  // Backtrack.
  const ops = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d > 0 && (x > 0 || y > 0); d--) {
    const vPrev = trace[d];
    const k = x - y;
    const down = !vPrev.has(k - 1) || (vPrev.has(k + 1) && vPrev.get(k - 1) < vPrev.get(k + 1));
    const kPrev = down ? k + 1 : k - 1;
    const xPrev = vPrev.get(kPrev) ?? 0;
    const yPrev = xPrev - kPrev;
    while (x > xPrev && y > yPrev) { ops.push({ op: '=', text: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (down) { ops.push({ op: '+', text: b[y - 1] }); y--; }
      else { ops.push({ op: '-', text: a[x - 1] }); x--; }
    }
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) { ops.push({ op: '=', text: a[x - 1] }); x--; y--; }
  return ops.reverse();
}

// Counts of additions / deletions in a diff. Equal lines don't count.
export function diffStats(ops) {
  let adds = 0, dels = 0;
  for (const o of ops) {
    if (o.op === '+') adds++;
    else if (o.op === '-') dels++;
  }
  return { adds, dels };
}
