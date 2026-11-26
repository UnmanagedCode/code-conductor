// The pending context chip of one live session: a title + freeform data a plugin
// sets, the composer's Send consumes once, and the session's end drops. In memory
// only, so a cc restart drops it too.
import { httpError } from './httpError.ts';
import type { ContextChip } from '../shared/wireRows.ts';

export const CHIP_TITLE_MAX = 200;
// Characters; under the 1 MB `express.json` limit in src/routes.ts.
export const CHIP_DATA_MAX = 256 * 1024;

function invalid(message: string): Error & { statusCode: number } {
  return httpError(400, message, { code: 'INVALID_ARGUMENT' });
}

// The body of PUT /api/sessions/:sid/chip, validated.
export function validateChipInput(body: unknown): { title: string; data: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { title?: unknown; data?: unknown };
  if (typeof b.title !== 'string') throw invalid('title must be a string');
  const title = b.title.trim();
  if (!title) throw invalid('title must not be empty');
  if (/[\r\n]/.test(title)) throw invalid('title must be a single line');
  if (title.length > CHIP_TITLE_MAX) throw invalid(`title is longer than ${CHIP_TITLE_MAX} characters`);
  if (typeof b.data !== 'string') throw invalid('data must be a string');
  if (b.data.length > CHIP_DATA_MAX) throw invalid(`data is longer than ${CHIP_DATA_MAX} characters`);
  return { title, data: b.data };
}

export class ContextChipSlot {
  #chip: ContextChip | null = null;
  // Never resets, so a rev names one chip for the slot's whole life.
  #rev = 0;
  // Bumped by every mutation; restore() compares it to see whether anything moved.
  #version = 0;
  // The version right after each take, so restore() can tell nothing moved since.
  #versionAtTake = new WeakMap<ContextChip, number>();
  #onChange: (chip: ContextChip | null) => void;

  constructor(onChange: (chip: ContextChip | null) => void) { this.#onChange = onChange; }

  get(): ContextChip | null { return this.#chip; }

  // Always replaces the current chip: there is no owner check.
  set(title: string, data: string): ContextChip {
    this.#chip = { title, data, rev: ++this.#rev };
    this.#version++;
    this.#onChange(this.#chip);
    return this.#chip;
  }

  // Without `rev`, unconditional; with it, only while that chip is still the one held.
  clear(rev?: number): boolean {
    if (!this.#chip || (rev !== undefined && this.#chip.rev !== rev)) return false;
    this.#chip = null;
    this.#version++;
    this.#onChange(null);
    return true;
  }

  // A synchronous compare-and-clear: the chip when `rev` is still current, else null.
  take(rev: number): ContextChip | null {
    const chip = this.#chip;
    if (!chip || chip.rev !== rev) return null;
    this.clear();
    this.#versionAtTake.set(chip, this.#version);
    return chip;
  }

  // Undo a take whose send failed — only when nothing has changed since it.
  restore(chip: ContextChip): void {
    if (this.#chip || this.#versionAtTake.get(chip) !== this.#version) return;
    this.#chip = chip;
    this.#version++;
    this.#onChange(chip);
  }
}
