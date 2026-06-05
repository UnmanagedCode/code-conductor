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
    this._playFn = playFn;
  }

  enqueue(item) {
    this._items.push(item);
    if (!this._draining) this._startDrain();
  }

  flush() {
    this._items.length = 0;
  }

  get size() { return this._items.length; }
  get draining() { return this._draining; }

  async _startDrain() {
    this._draining = true;
    while (this._items.length > 0) {
      const item = this._items.shift();
      item.onStart?.();
      await this._playFn(item.text);
    }
    this._draining = false;
  }
}
