import type { HubTab, SiteSettings } from "./ipc";
import { hostOf, siteOf } from "./site";

/** The hub the visible page belongs to, and the page's place among the hub's pages. */
export interface ActiveHub {
  recipeId: string;
  name: string;
  tabs: HubTab[];
  /** The index of the page the user is looking at. */
  active: number;
}

/** The host of a hub page, as the user reads it. */
export function tabHost(tab: HubTab): string {
  return hostOf(tab.url) ?? "";
}

/**
 * The page of the hub an address belongs to, or -1 when the address is on another site. Pages
 * are matched by the site they live on, not by their exact address, so a hub page stays the
 * current one while the user walks around inside it.
 */
export function tabIndexFor(tabs: readonly HubTab[], url: string): number {
  const site = siteOf(url);
  if (!site) return -1;
  return tabs.findIndex((tab) => siteOf(tab.url) === site);
}

/**
 * The hub the page belongs to, or null when it belongs to none. The first installed hub with a
 * page on the page's own site wins, so a hub never fights another one for the same page.
 */
export function activeHub(sites: readonly SiteSettings[], url: string | null): ActiveHub | null {
  if (!url) return null;
  for (const site of sites) {
    const tabs = site.hub?.tabs;
    if (!tabs || tabs.length === 0) continue;
    const active = tabIndexFor(tabs, url);
    if (active >= 0) return { recipeId: site.recipeId, name: site.name, tabs, active };
  }
  return null;
}
