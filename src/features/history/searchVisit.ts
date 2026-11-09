import { displayHost } from "../../shared/favorites";
import { SEARCH_ENGINES } from "../../shared/searchEngines";

const SEARCH_HOSTS = new Set(SEARCH_ENGINES.map((engine) => displayHost(engine.url)));

/** True for a page on one of the search engines the command bar can use. */
export function isSearchPage(url: string): boolean {
  return SEARCH_HOSTS.has(displayHost(url));
}

/**
 * True when a page went from a search engine to a site: the visit that belongs in History. The
 * search itself never does, and neither does moving around inside the site afterwards.
 */
export function leftSearchForSite(previousUrl: string | null, url: string): boolean {
  return (
    previousUrl !== null &&
    isSearchPage(previousUrl) &&
    /^https?:\/\//i.test(url) &&
    !isSearchPage(url)
  );
}
