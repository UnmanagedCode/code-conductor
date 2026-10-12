// The Settings sections in nav order: each one's id, nav label and the platform
// capability that gates it. DOM-free (no JSX, no `@/` imports) so the e2e suite
// imports it as well; SettingsView.tsx adds each section's icon and renderer.

export type SectionId = 'models' | 'conventions' | 'plugins' | 'backends' | 'systems' | 'account' | 'voice' | 'archived' | 'about';
export type SectionCapability = 'remoteSystems' | 'voice';
export type SectionCaps = Partial<Record<SectionCapability, boolean>>;

export const SECTION_CATALOG: readonly { id: SectionId; label: string; capability?: SectionCapability }[] = [
  { id: 'models', label: 'Models' },
  { id: 'conventions', label: 'Conventions' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'backends', label: 'Backends' },
  { id: 'systems', label: 'Systems', capability: 'remoteSystems' },
  { id: 'account', label: 'Account' },
  { id: 'voice', label: 'Voice', capability: 'voice' },
  { id: 'archived', label: 'Archived' },
  { id: 'about', label: 'About' },
];

/**
 * The sections this platform offers. Until capabilities load (`caps` null)
 * every section shows; a platform without remote systems / voice drops those,
 * so they are never fetched.
 */
export function offeredSections<T extends { capability?: SectionCapability }>(sections: readonly T[], caps: SectionCaps | null): T[] {
  return sections.filter((s) => !s.capability || !caps || !!caps[s.capability]);
}
