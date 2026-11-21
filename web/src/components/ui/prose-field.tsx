import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PROSE_FIELD_PROPS } from '@/lib/textEntry';

/**
 * Props a prose field owns: its traits, its name source (the label), and no `name`. Omitting them blocks `name` and a
 * conflicting trait at typecheck, but TypeScript exempts hyphenated JSX attributes from excess-property checks, so a
 * caller's `aria-label` / `aria-labelledby` still typechecks; the components strip both at runtime instead.
 */
type Owned = keyof typeof PROSE_FIELD_PROPS | 'name' | 'aria-label' | 'aria-labelledby';
type ProseProps<P> = Omit<P, Owned> & { label: string };
/** The aria name overrides a caller can still pass (see `Owned`); destructured out so the DOM never carries one. */
type AriaOverrides = { 'aria-label'?: string; 'aria-labelledby'?: string };

function useFieldId(id: string | undefined) {
  const generated = React.useId();
  return id ?? generated;
}

/**
 * A free-text field: a visually hidden <label for> naming the control, then the control carrying PROSE_FIELD_PROPS.
 * `autocomplete=off` does not stop Safari's contact AutoFill; an associated label is the defence, so a caller's aria name
 * override is dropped. A fragment, no wrapper.
 */
export function ProseInput({ label, id, 'aria-label': _ariaLabel, 'aria-labelledby': _ariaLabelledBy, ...props }: ProseProps<React.ComponentProps<typeof Input>> & AriaOverrides) {
  const fieldId = useFieldId(id);
  return (
    <>
      <label htmlFor={fieldId} className="sr-only">{label}</label>
      <Input {...props} id={fieldId} {...PROSE_FIELD_PROPS} />
    </>
  );
}

/** As ProseInput; `bare` renders a raw <textarea> with only the caller's classes (the composer's unstyled box inside its own card). */
export function ProseTextarea({ label, id, bare, 'aria-label': _ariaLabel, 'aria-labelledby': _ariaLabelledBy, ...props }: ProseProps<React.ComponentProps<'textarea'>> & AriaOverrides & { bare?: boolean }) {
  const fieldId = useFieldId(id);
  const Control = bare ? 'textarea' : Textarea;
  return (
    <>
      <label htmlFor={fieldId} className="sr-only">{label}</label>
      <Control {...props} id={fieldId} {...PROSE_FIELD_PROPS} />
    </>
  );
}
