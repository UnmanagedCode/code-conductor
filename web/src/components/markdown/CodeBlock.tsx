import * as React from 'react';
import type { Element } from 'hast';
import { copyToClipboard } from '@/components/CopyButton';

/** The concatenated text under `node`. Iterative. */
function textOf(node: Element): string {
  let out = '';
  const stack: Element['children'] = [...node.children].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'text') out += n.value;
    else if (n.type === 'element') stack.push(...[...n.children].reverse());
  }
  return out;
}

/**
 * A code block (fenced or indented, at any depth): its code with the info string's language as `data-lang`, and a Copy
 * button beside the <pre>, never inside it, that copies exactly the code and flashes its outcome for 1200 ms.
 */
export function CodeBlock({ node }: { node?: Element }) {
  const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
  const classes = code?.properties.className;
  const lang = Array.isArray(classes) ? classes.map(String).find((c) => c.startsWith('language-'))?.slice('language-'.length) : undefined;
  // mdast-util-to-hast ends a code block's text with one "\n" the source does not have.
  const text = code ? textOf(code).replace(/\n$/, '') : '';
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const flash = (s: 'copied' | 'failed') => {
    setState(s);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1200);
  };
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(text).then(() => flash('copied'), () => flash('failed'));
  };
  return (
    <div className="md-code-wrap">
      <button type="button" className={state === 'idle' ? 'md-code-copy' : `md-code-copy ${state}`} onClick={onClick}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
      <pre><code data-lang={lang}>{text}</code></pre>
    </div>
  );
}
