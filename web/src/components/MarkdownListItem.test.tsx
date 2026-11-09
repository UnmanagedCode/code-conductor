// Markdown converts list items through markdown/listItem.ts (linear in a list's items), not mdast-util-to-hast's default.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';
import { listItem } from './markdown/listItem';

vi.mock('./markdown/listItem', async (importOriginal) => {
  const real = await importOriginal<typeof import('./markdown/listItem')>();
  return { listItem: vi.fn(real.listItem) };
});

describe('list item conversion', () => {
  // Pins: rendering a list runs the listItem handler once per item, and the items render as its output.
  it('runs the listItem handler for every item', () => {
    const { container } = render(<Markdown text={'- a\n- b\n\n1. c'} />);
    expect(vi.mocked(listItem)).toHaveBeenCalledTimes(3);
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['a', 'b', 'c']);
  });
});
