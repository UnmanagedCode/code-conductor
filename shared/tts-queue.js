// FIFO speech queue for sequential TTS playback without interruption.
//
// Each item is { text, onStart? }. The drain loop plays one segment at a time,
// awaiting the playFn Promise before advancing. playFn must return a Promise
// that resolves when the segment finishes (naturally or via abort).
//
// flush() empties pending items; the current segment plays to completion (or
// until its session is externally aborted), then the drain exits.
//
// onStart (optional per-item callback) fires synchronously just before
// playFn is called — used to flip a button to speaking state at the moment
// the segment actually starts, not when it was enqueued.
export class TtsQueue {
  constructor(playFn) {
    this._items = [];
    this._draining = false;
    this._drainId = 0;
    this._playFn = playFn;
  }

  enqueue(item) {
    this._items.push(item);
    if (!this._draining) this._startDrain(++this._drainId);
  }

  flush() {
    this._items.length = 0;
  }

  // Reset the drain state so the next enqueue starts a fresh drain synchronously.
  // Used by requestSpeak() (tap) after _stopSilent(): the stale drain's microtask
  // continuation sees a mismatched id and exits without resetting _draining.
  interruptDrain() {
    this._draining = false;
    this._drainId++;
  }

  get size() { return this._items.length; }
  get draining() { return this._draining; }

  async _startDrain(id) {
    this._draining = true;
    while (this._items.length > 0) {
      const item = this._items.shift();
      item.onStart?.();
      await this._playFn(item.text);
      if (this._drainId !== id) return; // interrupted by requestSpeak; don't clean up
    }
    if (this._drainId === id) this._draining = false;
  }
}
