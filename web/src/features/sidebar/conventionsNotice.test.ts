// Which project convention selections the ⋮ flags: an unset one and one naming
// a slug that no longer resolves; never a deliberate choice of none.
import { describe, expect, it } from 'vitest';
import type { Project } from '@/state/types';
import { conventionsNotice } from './conventionsNotice';

const project = (conventions: Project['conventions']) => ({ name: 'p', path: '/p', conventions }) as Project;

describe('conventionsNotice', () => {
  it('flags an unset selection', () => {
    expect(conventionsNotice(project({ mode: 'unset', unresolved: [] }))).not.toBeNull();
  });

  it('does not flag a project that chose no conventions', () => {
    expect(conventionsNotice(project({ mode: 'none', unresolved: [] }))).toBeNull();
  });

  it('does not flag a selection whose slugs all resolve', () => {
    expect(conventionsNotice(project({ mode: 'selected', slugs: ['design-guidelines'], unresolved: [] }))).toBeNull();
  });

  it('names the selected slugs that no longer resolve', () => {
    const notice = conventionsNotice(project({ mode: 'selected', slugs: ['design-guidelines', 'gone', 'lost'], unresolved: ['gone', 'lost'] }));
    expect(notice).toContain('gone');
    expect(notice).toContain('lost');
    expect(notice).not.toContain('design-guidelines');
  });

  it('does not flag a selection that could not be read', () => {
    expect(conventionsNotice(project({ error: 'EACCES' }))).toBeNull();
  });

  it('does not flag a row with no conventions field', () => {
    expect(conventionsNotice(project(undefined))).toBeNull();
  });
});
