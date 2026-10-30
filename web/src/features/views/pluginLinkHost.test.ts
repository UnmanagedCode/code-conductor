import { beforeEach, describe, expect, it } from 'vitest';
import { CC_LINK_HOST } from '@/state/route';
import { startPluginLinkHost } from './pluginLinkHost';

const ATTR = 'data-cc-link-host';

describe('startPluginLinkHost', () => {
  beforeEach(() => { document.documentElement.removeAttribute(ATTR); });

  // Pins: the publisher writes the one link-host constant on cc's <html>, synchronously at start.
  it('publishes CC_LINK_HOST at start', () => {
    expect(document.documentElement.hasAttribute(ATTR), 'absent before start').toBe(false);
    startPluginLinkHost();
    expect(document.documentElement.getAttribute(ATTR)).toBe(CC_LINK_HOST);
  });
});
