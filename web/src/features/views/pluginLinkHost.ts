// Publishes cc's in-app link host (CC_LINK_HOST) on cc's <html> as data-cc-link-host, which the plugin bridge reads to
// catch a click on a `http://cc.internal/` link in a plugin page.
import { CC_LINK_HOST } from '@/state/route';

export function startPluginLinkHost(): void {
  document.documentElement.setAttribute('data-cc-link-host', CC_LINK_HOST);
}
