import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Input } from './input';
import { Textarea } from './textarea';

describe('shared text fields on a coarse pointer', () => {
  it("a caller's size class cannot strip the 16px touch font", () => {
    // Invariant: Input and Textarea keep pointer-coarse:text-base whatever size class the caller passes, so iOS never zooms on focus.
    const { container } = render(<><Input className="text-sm" /><Input className="text-xs" /><Textarea className="text-[13px]" /></>);
    const fields = Array.from(container.querySelectorAll('input, textarea'));
    expect(fields).toHaveLength(3);
    for (const f of fields) expect(f.classList.contains('pointer-coarse:text-base')).toBe(true);
  });
});
