// A plugin's `icon` (the catalog row field) as a lucide component: every name the manifest allow-list accepts, and the generic plug for anything else.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PLUGIN_ICONS } from '@shared/pluginIcons';
import * as pluginIcon from './PluginIcon';

const svgClass = (icon: string | null | undefined) => render(<pluginIcon.PluginIcon icon={icon} />).container.querySelector('svg')!.getAttribute('class');

describe('PluginIcon', () => {
  // Pins: each allow-listed name renders its own lucide icon (the lucide class is the icon's only DOM signature).
  for (const name of PLUGIN_ICONS) {
    it(`renders ${name}`, () => {
      expect(svgClass(name)).toContain(`lucide-${name}`);
    });
  }

  // Pins: no icon, or a name outside the allow-list (including an Object.prototype key), shows the generic plug.
  it('falls back to the plug', () => {
    for (const icon of [null, undefined, 'kanban', 'constructor']) expect(svgClass(icon)).toContain('lucide-plug');
  });
});
