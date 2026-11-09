import { describe, expect, it } from 'vitest';
import { previewSkillPart } from './skillPreview';

describe('previewSkillPart', () => {
  it('a body with no marker is all inline and has no skill', () => {
    expect(previewSkillPart('## Rule\n- a\n', 'workspace', 'my-rule')).toEqual({ inline: '## Rule\n- a' });
  });

  it('a marker splits the inline part from a skill named by scope and slug', () => {
    expect(previewSkillPart('## Rule\n<!-- cc:skill Use when X. -->\n\nSTEPS\n', 'project', 'my-rule')).toEqual({
      inline: '## Rule',
      skill: { invocation: 'cc-custom-project:my-rule', description: 'Use when X.', body: 'STEPS' },
    });
  });

  it('the invocation follows the scope', () => {
    for (const scope of ['workspace', 'conductor', 'project'] as const) {
      const p = previewSkillPart('<!-- cc:skill d -->\nb', scope, 's');
      expect('skill' in p && p.skill?.invocation).toBe(`cc-custom-${scope}:s`);
    }
  });

  it('a marker the server would refuse yields the parser message', () => {
    expect(previewSkillPart('## A\n<!-- cc:skill -->\nx', 'project', 's')).toEqual({ error: expect.stringContaining('empty description') });
    expect(previewSkillPart('<!-- cc:skill:named d -->\nx', 'project', 's')).toEqual({ error: expect.stringContaining('names its skill') });
    expect(previewSkillPart('<!-- cc:skill a -->\nx\n<!-- cc:skill b -->\ny', 'project', 's')).toEqual({ error: expect.stringContaining('second skill marker') });
  });
});
