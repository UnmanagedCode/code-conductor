import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export type Convention = { slug: string; name: string; description: string; plugin?: string | null; scaffold?: string };
export type ConventionGroup = { label: string; items: Convention[] };

/** Project conventions grouped: core ones first, then one group per contributing plugin. */
export function groupConventions(conventions: Convention[]) {
  const pluginOf = (c: Convention) => c.plugin ?? (c.slug.includes('/') ? c.slug.split('/')[0] : null);
  const groups: ConventionGroup[] = [];
  const core = conventions.filter((c) => !pluginOf(c));
  if (core.length) groups.push({ label: 'Project conventions', items: core });
  const byPlugin = new Map<string, Convention[]>();
  for (const c of conventions) {
    const p = pluginOf(c);
    if (!p) continue;
    if (!byPlugin.has(p)) byPlugin.set(p, []);
    byPlugin.get(p)!.push(c);
  }
  for (const p of [...byPlugin.keys()].sort()) groups.push({ label: p, items: byPlugin.get(p)! });
  return groups;
}

/** One checkbox per convention, under a legend per group. Renders nothing when there are no groups. */
export function ConventionChecklist({ groups, picked, onToggle, idPrefix }: {
  groups: ConventionGroup[]; picked: Set<string>; onToggle: (slug: string, checked: boolean) => void; idPrefix: string;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="relative grid max-h-64 gap-3 overflow-y-auto rounded-xl border p-3">
      {/* Positioned: Radix's hidden form inputs stay in this list and scroll with it instead of extending the dialog. */}
      {groups.map((g) => (
        <fieldset key={g.label} className="grid gap-2">
          <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.label}</legend>
          {g.items.map((c) => {
            const id = `${idPrefix}-conv-${c.slug}`;
            return (
              <div key={c.slug} className="flex items-start gap-3">
                <Checkbox
                  id={id}
                  checked={picked.has(c.slug)}
                  data-convention={c.slug}
                  onCheckedChange={(v) => onToggle(c.slug, v === true)}
                  className="mt-0.5"
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={id}>{c.name}</Label>
                  <p className="text-xs text-muted-foreground">{c.description}</p>
                </div>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
