import { describe, expect, it } from 'vitest';
import {
  describeBinding, defaultClaudeModel, envFromText, envToText, firstModelForBackend, fmtCtxTokens, launchFromText, modelsForBackend,
  parseCtxTokens, type ModelsPayload,
} from './models/logic';
import { contributions, hookWarning, metaBits, updateChange, updateWarning, type PluginRow } from './pluginLogic';
import { playbookOptions, ENFORCEMENT_LABELS } from './ConventionsSection';
import { describeAuth } from './ClaudeLogin';
import { describeUpdate } from './AboutSection';
import { orderGroups, archivedSessionUrl } from './ArchivedSection';
import { visibleSections } from './SettingsView';

const data: ModelsPayload = {
  backends: [{ id: 'claude', label: 'Claude', managed: true }, { id: 'ollama', label: 'Ollama', managed: true }, { id: 'mine', label: 'Mine' }],
  claudeFamilies: [
    { family: 'opus', label: 'Opus', default: 'claude-opus-5-5', versions: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] },
    { family: 'sonnet', label: 'Sonnet', default: 'claude-sonnet-5-5', versions: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] },
  ],
  ollamaCloudModels: [{ model: 'a:cloud', label: 'A' }, { model: 'b:cloud', label: 'B' }],
  ollamaCloudTierDefaults: { fast: 'b:cloud' },
  customModels: [{ label: 'Mine 1', model: 'm1', backend: 'mine', contextWindow: 200000 }],
};

describe('models logic', () => {
  it('parses context sizes with k / m shorthand and refuses anything else', () => {
    expect(parseCtxTokens('200000')).toBe(200000);
    expect(parseCtxTokens('200k')).toBe(200000);
    expect(parseCtxTokens('1m')).toBe(1000000);
    expect(parseCtxTokens('1.5M')).toBe(1500000);
    expect(parseCtxTokens('')).toBeNull();
    expect(parseCtxTokens('0')).toBeNull();
    expect(parseCtxTokens('lots')).toBeNull();
    expect(fmtCtxTokens(200000)).toBe('200k');
    expect(fmtCtxTokens(1500000)).toBe('1.5M');
  });

  it('parses env lines as KEY=VALUE, keeping = inside the value and dropping blanks', () => {
    expect(envFromText('A=1\n\n B=x=y \nFLAG')).toEqual([{ key: 'A', value: '1' }, { key: 'B', value: 'x=y' }, { key: 'FLAG', value: '' }]);
    expect(envToText([{ key: 'A', value: '1' }, { key: 'B', value: '2' }])).toBe('A=1\nB=2');
  });

  it('sends the provider command as argv, and an empty one as null (clear), never []', () => {
    expect(launchFromText('  docker exec -i ctr  cc-provider ')).toEqual(['docker', 'exec', '-i', 'ctr', 'cc-provider']);
    expect(launchFromText('   ')).toBeNull();
  });

  it('offers the curated catalog on ollama only; a user backend gets its own models', () => {
    expect(modelsForBackend(data, 'ollama').curated).toHaveLength(2);
    expect(modelsForBackend(data, 'mine')).toEqual({ curated: [], custom: data.customModels });
  });

  it('switching a tier to a backend picks its tier default, then the user model, else refuses', () => {
    expect(firstModelForBackend(data, 'ollama', 'fast')?.model).toBe('b:cloud');
    expect(firstModelForBackend(data, 'ollama', 'balanced')?.model).toBe('a:cloud');
    expect(firstModelForBackend(data, 'mine', 'fast')?.model).toBe('m1');
    expect(firstModelForBackend(data, 'nothing-here', null)).toBeNull();
  });

  it('a switch back to Claude lands on Sonnet\'s default; bindings describe themselves', () => {
    expect(defaultClaudeModel(data)).toBe('claude-sonnet-5-5');
    expect(describeBinding(data, { backend: 'claude', model: 'claude-opus-5-5' })).toBe('Opus 5.5');
    expect(describeBinding(data, { backend: 'mine', model: 'm1' })).toBe('Mine — m1');
  });
});

describe('plugin logic', () => {
  const rows: PluginRow[] = [
    { id: 'p1', name: 'P1', project: 'proj', state: 'ready', version: '1.2.0', gitHead: 'abcdef123', stale: true, port: 4000 },
    { id: 'p2', name: 'P2', project: 'proj', state: 'stopped', activeVersion: { type: 'worktree', name: 'wt' } },
    { id: 'p3', name: 'P3', project: 'other', state: 'ready' },
  ];

  it('the meta line names version, running checkout, staleness and port', () => {
    expect(metaBits(rows[0])).toEqual(['project proj', 'v1.2.0', 'running main @ abcdef1', 'update available', 'port 4000']);
    expect(metaBits(rows[1])).toEqual(['project proj', 'version wt']);
  });

  it('a contributions-only row badges its playbooks beside its roles', () => {
    expect(contributions({ ...rows[2], roles: [1, 2], playbooks: [1] })).toEqual(['2 roles', '1 playbook']);
  });

  it('an update names every plugin of each updated project', () => {
    expect(updateChange([{ project: 'proj' }], rows)).toEqual({ action: 'update', ids: ['p1', 'p2'] });
  });

  it('a failed post-update hook wins over a failed restart; a skipped restart says the old code still runs', () => {
    expect(updateWarning('X', { project: 'p' })).toBeNull();
    expect(updateWarning('X', { project: 'p', postPull: { ran: true, ok: false, tail: 't' }, restarted: { ok: false, error: 'e' } }))
      .toEqual({ text: 'Updated X, but its post-update command failed', tail: 't' });
    expect(updateWarning('X', { project: 'p', postPull: { ran: true, ok: false, tail: 't' }, restarted: { skipped: true } })!.text).toMatch(/left running the old code/);
    expect(updateWarning('X', { project: 'p', restarted: { ok: false, error: 'boom' } })!.text).toBe('Updated X, but restarting its backend failed: boom');
  });

  it('a failed postClone after a good clone is a warning', () => {
    expect(hookWarning('X', 'Installed', 'post-install', { ran: true, ok: false, tail: 'oops' })).toEqual({ text: 'Installed X, but its post-install command failed', tail: 'oops' });
    expect(hookWarning('X', 'Installed', 'post-install', { ran: false })).toBeNull();
  });
});

describe('conductor playbook prefs', () => {
  const base = { defaultPlaybookFallback: 'relay', playbooks: [{ id: 'solo', name: 'Solo' }, { id: 'kb', name: 'Kanban', plugin: 'code-kanban' }] };

  it('lists Unset, None and one row per playbook, labelling plugin playbooks, and preselects the stored choice', () => {
    const o = playbookOptions({ ...base, defaultPlaybook: { mode: 'playbook', id: 'solo' } });
    expect(o.opts.map((x) => x.value)).toEqual(['unset', 'none', 'playbook:solo', 'playbook:kb']);
    expect(o.opts[0].label).toBe('Unset — falls back to relay');
    expect(o.opts[3].label).toBe('kb — Kanban (plugin code-kanban)');
    expect(o.value).toBe('playbook:solo');
    expect(playbookOptions({ ...base, defaultPlaybook: { mode: 'none' } }).value).toBe('none');
    expect(playbookOptions(base).value).toBe('unset');
  });

  it('a stored choice that is not loaded renders disabled with its reason; rejected definitions are surfaced', () => {
    const o = playbookOptions({ ...base, defaultPlaybook: { mode: 'playbook', id: 'gone' }, defaultPlaybookMissing: { id: 'gone', reason: 'gone is not loaded' }, playbookErrors: [{ id: 'bad', message: 'no stages' }] });
    expect(o.opts.at(-1)).toEqual({ value: 'playbook:gone', label: 'gone — not loaded', disabled: true });
    expect(o.notes).toBe('gone is not loaded 1 playbook definition(s) rejected at load: bad: no stages');
  });

  it('enforcement levels carry explanatory labels', () => {
    expect(ENFORCEMENT_LABELS.enforce).toMatch(/refused/);
    expect(ENFORCEMENT_LABELS.warn).toMatch(/proceed/);
  });
});

describe('account / about / archived', () => {
  it('a signed-in subscription shows identity and plan, skipping missing fields', () => {
    expect(describeAuth({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', orgName: null, subscriptionType: 'max' }))
      .toEqual({ head: 'Signed in', details: ['a@b.c', 'Max plan', 'Claude subscription'], apiKeyNote: false });
    expect(describeAuth({ loggedIn: false }).head).toBe('Not signed in');
    expect(describeAuth({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }))
      .toEqual({ head: 'Using an API key', details: ['ANTHROPIC_API_KEY'], apiKeyNote: true });
  });

  it('self-update offers Update only when a fast-forward is available', () => {
    expect(describeUpdate({ version: '1.0', canCheck: false })).toEqual({ text: "v1.0 · can't check for updates (no upstream branch)", canUpdate: false });
    expect(describeUpdate({ version: '1.0', canCheck: true, diverged: true, ahead: 1, behind: 2, upstream: 'origin/main' }).canUpdate).toBe(false);
    expect(describeUpdate({ version: '1.0', canCheck: true, updateAvailable: true, behind: 3, upstream: 'origin/main' }))
      .toEqual({ text: 'v1.0 · update available (3 commits behind origin/main)', canUpdate: true });
    expect(describeUpdate({ version: '1.0', canCheck: true }).text).toBe('v1.0 · up to date');
  });

  it('archived conductor sessions sort first; URLs address worktree sessions under their worktree', () => {
    expect(orderGroups([{ project: 'a', sessions: [] }, { project: '.conduct', sessions: [] }]).map((g) => g.project)).toEqual(['.conduct', 'a']);
    expect(archivedSessionUrl('p', 'w t', 's', '/restore')).toBe('/api/projects/p/worktrees/w%20t/sessions/s/restore');
    expect(archivedSessionUrl('p', null, 's', '')).toBe('/api/projects/p/sessions/s');
  });

  it('Systems and Voice are dropped where the platform lacks them', () => {
    expect(visibleSections({ remoteSystems: false, voice: false }).map((s) => s.id)).not.toContain('systems');
    expect(visibleSections({ remoteSystems: false, voice: false }).map((s) => s.id)).not.toContain('voice');
    expect(visibleSections({ remoteSystems: true, voice: true }).map((s) => s.id)).toEqual(
      ['models', 'conventions', 'plugins', 'backends', 'systems', 'account', 'voice', 'archived', 'about']);
  });
});
