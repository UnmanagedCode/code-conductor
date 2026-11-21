import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PROSE_FIELD_PROPS } from '@/lib/textEntry';

/** Props a prose field owns: its traits, its name source (the label), and no `name`. */
type Owned = keyof typeof PROSE_FIELD_PROPS | 'name' | 'aria-label' | 'aria-labelledby';
type ProseProps<P> = Omit<P, Owned> & { label: string };

function useFieldId(id: string | undefined) {
  const generated = React.useId();
  return id ?? generated;
}

/**
 * A free-text field: a visually hidden <label for> naming the control, then the control carrying PROSE_FIELD_PROPS.
 * `autocomplete=off` does not stop Safari's contact AutoFill; an associated label is the defence. A fragment, no wrapper.
 */
export function ProseInput({ label, id, ...props }: ProseProps<React.ComponentProps<typeof Input>>) {
  const fieldId = useFieldId(id);
  return (
    <>
      <label htmlFor={fieldId} className="sr-only">{label}</label>
      <Input {...props} id={fieldId} {...PROSE_FIELD_PROPS} />
    </>
  );
}

/** As ProseInput; `bare` renders a raw <textarea> with only the caller's classes (the composer's unstyled box inside its own card). */
export function ProseTextarea({ label, id, bare, ...props }: ProseProps<React.ComponentProps<'textarea'>> & { bare?: boolean }) {
  const fieldId = useFieldId(id);
  const Control = bare ? 'textarea' : Textarea;
  return (
    <>
      <label htmlFor={fieldId} className="sr-only">{label}</label>
      <Control {...props} id={fieldId} {...PROSE_FIELD_PROPS} />
    </>
  );
}
