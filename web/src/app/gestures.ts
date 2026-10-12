// Which user gesture's selection stands. A gesture that selects a session only
// after async work (a resume, a notification click's lookup, a spawn, a fork)
// takes a token when it starts. A selection made meanwhile by a gesture started
// after it overtakes it, and it then selects nothing: between two gestures the
// newest wins, whichever lands last. An automatic selection (the first-connect
// restore, Back/forward) is no gesture and overtakes none.
let started = 0;
let shown = 0;

/** A token for a gesture that selects a session once its async work is done; pass it to that `selectInstance`. */
export function beginGesture(): number {
  return ++started;
}

/** Record that gesture `g` has selected a session; a pick, which selects at once, omits it and starts one. */
export function gestureSelected(g: number = beginGesture()): void {
  shown = g;
}

/** True once a gesture started after `g` has selected a session: `g` must not select over it. */
export function gestureOvertaken(g: number): boolean {
  return shown > g;
}
