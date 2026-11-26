// Every hash writer keeps the page's pathname and query, so the `?focus=<sid>`
// marker survives navigation, and no `#` route reads it.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushSessionAnchor, writeSessionAnchor } from '@shared/anchor';
import { closeView, openView, parseHash, replaceHash } from './route';

const START = '/plugins/x/?focus=S';
const keeps = () => { expect(location.pathname).toBe('/plugins/x/'); expect(location.search).toBe('?focus=S'); };

beforeEach(() => { history.replaceState(null, '', START); });
afterEach(() => { history.replaceState(null, '', '/'); });

// Invariant: the marker survives every hash writer (and the pathname with it).
describe('hash writers keep the pathname and the query', () => {
  it('writeSessionAnchor', () => { writeSessionAnchor('W'); keeps(); expect(location.hash).toBe('#session=W'); });
  it('pushSessionAnchor', () => { pushSessionAnchor('W'); keeps(); expect(location.hash).toBe('#session=W'); });
  it('openView a settings view', () => { openView('#settings'); keeps(); expect(location.hash).toBe('#settings'); });
  it('openView a plugin view', () => { openView('#plugin/code-editor/?ccPath=a'); keeps(); });
  it('replaceHash', () => { replaceHash('#settings/voice'); keeps(); expect(location.hash).toBe('#settings/voice'); });
  it('closeView on a deep link writes the anchor', () => {
    history.replaceState(null, '', `${START}#settings`);
    closeView('W');
    keeps();
    expect(location.hash).toBe('#session=W');
  });
});

// Invariant: the marker clashes with no `#` route — a plugin route's subpath is the whole hash tail.
it('a plugin route keeps its subpath whole beside the marker', () => {
  openView('#plugin/code-editor/?ccPath=a');
  expect(parseHash(location.hash)).toMatchObject({ view: 'plugin', pluginId: 'code-editor', pluginPath: '?ccPath=a' });
  keeps();
});
