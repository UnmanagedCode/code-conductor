import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProseInput, ProseTextarea } from './prose-field';
import { proseExpected, proseFacts } from '@/test/proseField';

describe('ProseInput / ProseTextarea', () => {
  it('every branch puts the prose traits on its control, no name, and names it only through its label', () => {
    // Invariant: each branch's control carries PROSE_FIELD_PROPS and no `name`, and its associated <label for> is its sole name source.
    render(<>
      <ProseInput label="One" />
      <ProseTextarea label="Two" />
      <ProseTextarea bare label="Three" />
    </>);
    for (const label of ['One', 'Two', 'Three']) expect(proseFacts(screen.getByRole('textbox', { name: label }))).toEqual(proseExpected(label));
  });

  it('honours a caller-supplied id on the control and the label', () => {
    // Invariant: pinned ids (#composer-input, #rename-title) survive the component.
    render(<><ProseInput id="pinned-input" label="One" /><ProseTextarea bare id="pinned-area" label="Two" /></>);
    for (const [label, id] of [['One', 'pinned-input'], ['Two', 'pinned-area']]) {
      const control = screen.getByRole('textbox', { name: label });
      expect(control.id).toBe(id);
      expect([...document.querySelectorAll('label')].filter((l) => l.htmlFor === id).map((l) => l.textContent)).toEqual([label]);
    }
  });

  it('generated ids do not collide between instances', () => {
    // Invariant: the label/control association is per instance, so several fields on one page each get their own name.
    render(<><ProseInput label="A" /><ProseInput label="B" /><ProseTextarea label="C" /></>);
    const ids = ['A', 'B', 'C'].map((name) => screen.getByRole('textbox', { name }).id);
    for (const id of ids) expect(id).not.toBe('');
    expect(new Set(ids).size).toBe(3);
  });

  it('forwards ref to the real control', () => {
    // Invariant: callers (the composer's taRef) hold a handle to the actual input/textarea element.
    const inputRef = React.createRef<HTMLInputElement>();
    const areaRef = React.createRef<HTMLTextAreaElement>();
    const bareRef = React.createRef<HTMLTextAreaElement>();
    render(<>
      <ProseInput ref={inputRef} label="In" />
      <ProseTextarea ref={areaRef} label="Area" />
      <ProseTextarea bare ref={bareRef} label="Bare" />
    </>);
    expect(inputRef.current).toBeInstanceOf(HTMLInputElement);
    expect(inputRef.current).toBe(screen.getByRole('textbox', { name: 'In' }));
    expect(areaRef.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(areaRef.current).toBe(screen.getByRole('textbox', { name: 'Area' }));
    expect(bareRef.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(bareRef.current).toBe(screen.getByRole('textbox', { name: 'Bare' }));
  });

  it('renders a fragment of exactly label + control, and bare emits the raw textarea with only the caller classes', () => {
    // Invariant: no wrapper element, so the field sits in its parent's flow exactly as the control alone did; bare skips the styled shadcn Textarea so the composer's layout cannot shift.
    const tags = (node: React.ReactNode) => {
      const { container, unmount } = render(<>{node}</>);
      const out = { tags: [...container.children].map((c) => c.tagName), control: container.children[1] as HTMLElement };
      return { ...out, unmount };
    };
    const input = tags(<ProseInput label="In" />);
    expect(input.tags).toEqual(['LABEL', 'INPUT']);
    input.unmount();
    const styled = tags(<ProseTextarea label="Area" />);
    expect(styled.tags).toEqual(['LABEL', 'TEXTAREA']);
    expect(styled.control.getAttribute('data-slot')).toBe('textarea');
    styled.unmount();
    const bare = tags(<ProseTextarea bare label="Bare" className="caller-only" />);
    expect(bare.tags).toEqual(['LABEL', 'TEXTAREA']);
    expect(bare.control.hasAttribute('data-slot')).toBe(false);
    expect(bare.control.className).toBe('caller-only');
  });

  it('passes caller props through to the control', () => {
    // Invariant: everything but the owned traits/name reaches the control (placeholder, disabled, controlled value and its onChange).
    const onChange = vi.fn();
    render(<>
      <ProseInput label="In" placeholder="Type here" value="v1" onChange={onChange} />
      <ProseTextarea label="Off" disabled value="" onChange={() => {}} />
    </>);
    const input = screen.getByRole('textbox', { name: 'In' }) as HTMLInputElement;
    expect(input.placeholder).toBe('Type here');
    expect(input.value).toBe('v1');
    fireEvent.change(input, { target: { value: 'v2' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox', { name: 'Off' }) as HTMLTextAreaElement).disabled).toBe(true);
  });
});
