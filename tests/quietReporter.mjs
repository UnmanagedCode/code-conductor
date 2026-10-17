// The quiet reporter: decides which node:test events reach tests/run.mjs's spec
// reporter, so a passing run prints its summary and not ~9k per-test lines.
//
// It filters ONLY what spec sees. Every ledger and hang-guard listener in run.mjs
// stays on the SOURCE stream, so what the runner knows about a file — reported,
// killed, settled — does not depend on anything here.
//
// This module is NOT named `*.test.mjs`, so run.mjs's discover() ignores it —
// same convention as procTree.mjs.
//
// WHAT IT RESTS ON (node v24.18.0, measured):
//   * Every byte a test file writes — console.log, a raw writeSync(2, …), Layer
//     B's `handle-leak-guard:` text — arrives as a test:stdout/test:stderr event
//     carrying `data.file`. The runner's own console.log/console.error lines are
//     not events and never pass through here.
//   * Each file's display events form one contiguous segment, in `files` order:
//     node holds a later file's report until the earlier ones have reported.
//   * spec pairs each test:pass/test:fail with the test:start on top of its stack
//     and ASSERTS that name and nesting match, so a file's events must reach it
//     as an unbroken subsequence or not at all. A lone test:pass on an empty
//     stack is fine.
//   * The segment's end tells the file's fate: a passing file closes with a
//     per-file test:summary; a failing, Layer-B-leaking or killed one carries a
//     test:fail (node synthesizes a file-level one for a killed child) and no
//     summary; a file that exits before registering a test sends a lone
//     file-level test:pass and no summary. The run-level events
//     (`data.file === undefined`) come last: test:plan, the `ℹ` count
//     diagnostics, then the run-level test:summary, on which spec prints its
//     `failing tests:` block.
import { Transform, Readable } from 'node:stream';
import { spec } from 'node:test/reporters';

export const isVerbose = (env = process.env) => env.CC_TEST_VERBOSE === '1';

const DISPLAY = new Set(['test:start', 'test:pass', 'test:fail', 'test:stdout', 'test:stderr', 'test:diagnostic']);

// A file's state:
//   held   — events buffered, nothing forwarded yet (every file starts here);
//   live   — it failed, or the run ended without its summary: the buffer was
//            forwarded and every later event is forwarded as it comes;
//   passed — its summary arrived: only its skip/todo lines were forwarded, and
//            the buffer is KEPT for takeUnshown();
//   dumped — takeUnshown() printed its buffer: later events are forwarded.
export class QuietFilter extends Transform {
  #files = new Map(); // file -> { state, events[] }, in first-seen order

  constructor() {
    super({ objectMode: true });
  }

  #entry(file) {
    let e = this.#files.get(file);
    if (!e) this.#files.set(file, e = { state: 'held', events: [] });
    return e;
  }

  #forward(e) {
    for (const ev of e.events) this.push(ev);
    e.events = [];
    e.state = 'live';
  }

  // The run ended (or is ending) without these files' summaries: the NO REPORT
  // shape. Forwarded BEFORE the run-level events, so the output lands above the
  // `ℹ` counts and the `failing tests:` block.
  #forwardHeld() {
    for (const e of this.#files.values()) if (e.state === 'held') this.#forward(e);
  }

  _transform(event, _enc, cb) {
    const { type, data } = event;
    const file = data?.file;
    if (file === undefined) {
      this.#forwardHeld();
      this.push(event);
      return cb();
    }
    const e = this.#entry(file);
    if (e.state === 'live' || e.state === 'dumped') {
      this.push(event);
      return cb();
    }
    if (DISPLAY.has(type)) {
      // A `passed` file's late write (an orphan on inherited stdio) is kept for
      // takeUnshown() and never forwarded through the main pipe.
      e.events.push(event);
      if (type === 'test:fail' && e.state === 'held') this.#forward(e);
      return cb();
    }
    if (type === 'test:summary' && e.state === 'held') {
      // spec's own skip and todo lines, each alone: at a segment boundary spec's
      // stack is empty, so a test:pass with no test:start is accepted. Each is
      // then dropped from the kept buffer WITH its test:start, so a later dump
      // neither prints it twice nor leaves spec a start that nothing pairs with.
      const shown = new Set();
      e.events.forEach((ev, i) => {
        if (ev.type !== 'test:pass' || (ev.data.skip === undefined && ev.data.todo === undefined)) return;
        this.push(ev);
        shown.add(i);
        for (let j = i - 1; j >= 0; j--) {
          const s = e.events[j];
          if (s.type === 'test:start' && !shown.has(j) && s.data.name === ev.data.name && s.data.nesting === ev.data.nesting) {
            shown.add(j);
            break;
          }
        }
      });
      e.events = e.events.filter((_, i) => !shown.has(i));
      e.state = 'passed';
    }
    // Everything else spec ignores: enqueue/dequeue/complete/plan, a per-file
    // summary.
    this.push(event);
    cb();
  }

  _flush(cb) {
    this.#forwardHeld();
    cb();
  }

  // Every file whose output has not been printed — held, or passed with its
  // buffer kept — in first-seen order, marking each dumped so nothing it emits
  // later is printed twice. For a red run no file owns (cap, stall, sweep).
  takeUnshown() {
    const groups = [];
    for (const e of this.#files.values()) {
      if (e.state !== 'held' && e.state !== 'passed') continue;
      if (e.events.length > 0) groups.push(e.events);
      e.events = [];
      e.state = 'dumped';
    }
    return groups;
  }
}

// One FRESH spec instance per group: a held file cut off mid-describe (a dangling
// test:start on the cap path) must not trip spec's name assertion on the next.
export async function renderEvents(groups) {
  let out = '';
  for (const group of groups) {
    out += (await Readable.from(group).compose(new spec()).toArray()).join('');
  }
  return out;
}
