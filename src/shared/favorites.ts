import type { FavoriteInput } from "./ipc";
import { siteOf } from "./site";

/** How many favorites the floating button fans out for Pro. The rest stay in Settings. */
export const QUICK_ACCESS_LIMIT = 6;

/**
 * How many of those slots a free user can use. Mirrors `FREE_FAVORITE_LIMIT` in `library.rs`,
 * which also refuses to grow the favorites past it. The other slots show grayed out.
 */
export const FREE_QUICK_ACCESS_LIMIT = 4;

/** Mirrors `MAX_FAVORITE_NAME_CHARS` in `library.rs`, which is what enforces it. */
export const MAX_FAVORITE_NAME_CHARS = 20;

/** The favorites that appear when the floating button is held: the first few, in order. */
export function quickAccess<T>(favorites: readonly T[]): T[] {
  return favorites.slice(0, QUICK_ACCESS_LIMIT);
}

/** The quick-access favorites a user may actually open: all of them with Pro, the first few without. */
export function usableQuickAccess<T>(favorites: readonly T[], pro: boolean): T[] {
  return favorites.slice(0, pro ? QUICK_ACCESS_LIMIT : FREE_QUICK_ACCESS_LIMIT);
}

/** One position in the quick-access menu. A locked one needs Pro and may hold a favorite or be empty. */
export interface QuickSlot<T> {
  favorite: T | null;
  locked: boolean;
}

/**
 * The positions of the quick-access menu. Pro has one per favorite, up to six. Without Pro the
 * first four are usable and the last two are always shown, locked, so the way up is visible.
 */
export function quickSlots<T>(favorites: readonly T[], pro: boolean): QuickSlot<T>[] {
  const usable = usableQuickAccess(favorites, pro).map((favorite) => ({ favorite, locked: false }));
  if (pro) return usable;
  const locked = Array.from({ length: QUICK_ACCESS_LIMIT - FREE_QUICK_ACCESS_LIMIT }, (_, i) => ({
    favorite: favorites[FREE_QUICK_ACCESS_LIMIT + i] ?? null,
    locked: true,
  }));
  return [...usable, ...locked];
}

/** The host as the user reads it, without the `www.` every site adds. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/** True when a favorite already points at the site this address belongs to. */
export function isFavoriteSite(favorites: readonly { url: string }[], url: string): boolean {
  const site = siteOf(url);
  if (!site) return false;
  return favorites.some((favorite) => siteOf(favorite.url) === site);
}

/**
 * The favorites with this site's entry added or taken away. The other favorites keep their names
 * and their order, and the new entry goes last, so the quick-access menu does not jump around.
 */
export function toggleSiteFavorite(
  favorites: readonly { name: string; url: string }[],
  url: string,
): FavoriteInput[] {
  const site = siteOf(url);
  if (!site) return favorites.map(({ name, url: address }) => ({ name, url: address }));
  const kept = favorites
    .filter((favorite) => siteOf(favorite.url) !== site)
    .map(({ name, url: address }) => ({ name, url: address }));
  if (kept.length !== favorites.length) return kept;
  let root: string;
  try {
    root = `${new URL(url).origin}/`;
  } catch {
    return kept;
  }
  kept.push({ name: favoriteName(url), url: root });
  return kept;
}

/** The name a new favorite gets: the site's host, or the site it belongs to, short enough for the library to accept. */
function favoriteName(url: string): string {
  const host = displayHost(url);
  if (host.length <= MAX_FAVORITE_NAME_CHARS) return host;
  const site = siteOf(url);
  if (site && site.length <= MAX_FAVORITE_NAME_CHARS) return site;
  return host.slice(0, MAX_FAVORITE_NAME_CHARS);
}
