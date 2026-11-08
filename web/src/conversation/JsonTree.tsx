import * as React from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { cn } from '@/lib/utils';
import { childCount, MAX_TREE_DEPTH, type JsonContainer, type JsonDoc, type JsonNode } from './jsonTree';
import { SYNTAX_CLASS } from './syntaxClass';

type TokClass = keyof typeof SYNTAX_CLASS;
const KIND_CLASS: Record<string, TokClass | undefined> = {
  key: 'key', string: 'string', number: 'number', boolean: 'keyword', null: 'keyword',
};

type Ctx = { source: string; isOpen: (n: JsonContainer) => boolean; onToggle: (n: JsonContainer, open: boolean) => void };

const Tok = ({ kind, children }: { kind: string; children: React.ReactNode }) => {
  const c = KIND_CLASS[kind];
  return <span data-tok={kind} className={c ? SYNTAX_CLASS[c] : undefined}>{children}</span>;
};

const indent = (depth: number) => '  '.repeat(depth);
const Key = ({ k }: { k: string | null }) => (k === null ? null : <><Tok kind="key">{k}</Tok>{': '}</>);

function ContainerLine({ node, k, idx, comma, ctx }: { node: JsonContainer; k: string | null; idx?: number; comma: string; ctx: Ctx }) {
  const open = ctx.isOpen(node);
  const n = childCount(node);
  const [o, c] = node.kind === 'object' ? ['{', '}'] : ['[', ']'];
  const toggle = () => {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
    ctx.onToggle(node, !open);
  };
  const noun = node.kind === 'object' ? (n === 1 ? 'key' : 'keys') : (n === 1 ? 'item' : 'items');
  const name = k ?? (idx === undefined ? 'JSON' : `[${idx}]`);
  return (
    <div data-json-node={node.kind} data-json-open={open}>
      <div data-json-header className="relative cursor-pointer pl-4" onClick={toggle}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={name}
          className="absolute top-0 left-0 flex h-5 w-4 items-center justify-center text-muted-foreground select-none"
        >
          <ChevronRightIcon className={cn('size-3 transition-transform', open && 'rotate-90')} />
        </button>
        {indent(node.depth)}<Key k={k} />
        {open ? o : (
          <>
            <span data-json-summary>{o}…{c}</span>
            <span className="text-muted-foreground select-none">{` ${n} ${noun}`}</span>{comma}
          </>
        )}
      </div>
      {open && (
        <>
          <div role="group">
            {node.kind === 'object'
              ? node.entries.map((e, i) => <JsonValue key={i} node={e.value} k={e.key} comma={i < node.entries.length - 1 ? ',' : ''} ctx={ctx} />)
              : node.items.map((it, i) => <JsonValue key={i} node={it} k={null} idx={i} comma={i < node.items.length - 1 ? ',' : ''} ctx={ctx} />)}
          </div>
          <div className="pl-4">{indent(node.depth)}{c}{comma}</div>
        </>
      )}
    </div>
  );
}

function JsonValue({ node, k, idx, comma, ctx }: { node: JsonNode; k: string | null; idx?: number; comma: string; ctx: Ctx }) {
  if (node.kind !== 'object' && node.kind !== 'array') {
    return <div className="pl-4">{indent(node.depth)}<Key k={k} /><Tok kind={node.kind}>{node.text}</Tok>{comma}</div>;
  }
  if (childCount(node) === 0) {
    return <div className="pl-4">{indent(node.depth)}<Key k={k} />{node.kind === 'object' ? '{}' : '[]'}{comma}</div>;
  }
  if (node.depth >= MAX_TREE_DEPTH) {
    return <div className="pl-4">{indent(node.depth)}<Key k={k} /><Tok kind="raw">{ctx.source.slice(node.start, node.end)}</Tok>{comma}</div>;
  }
  return <ContainerLine node={node} k={k} idx={idx} comma={comma} ctx={ctx} />;
}

/** One JSON block as an indented, foldable tree of text children only (never HTML), with a copy of its exact source. */
export function JsonTree({ doc, source, isOpen, onToggle }: {
  doc: JsonDoc; source: string; isOpen: (n: JsonContainer) => boolean; onToggle: (n: JsonContainer, open: boolean) => void;
}) {
  const ctx = React.useMemo<Ctx>(() => ({ source, isOpen, onToggle }), [source, isOpen, onToggle]);
  return (
    <div data-json-tree className="group/json relative whitespace-pre-wrap">
      <CopyButton label="Copy JSON" getText={() => source} className="absolute top-0 right-0 z-10 opacity-0 group-hover/json:opacity-100 [@media(hover:none)]:opacity-100" />
      <JsonValue node={doc.root} k={null} comma="" ctx={ctx} />
    </div>
  );
}
