import type { FavoriteInput } from "./ipc";
import { siteOf } from "./site";

/** How many favorites the floating button fans out for Pro. The rest stay in Settings. */
export const QUICK_ACCESS_LIMIT = 5;

/**
 * How many of those slots a free user can use. Mirrors `FREE_FAVORITE_LIMIT` in `library.rs`,
 * which also refuses to grow the favorites past it. The other slots show grayed out.
 */
export const FREE_QUICK_ACCESS_LIMIT = 3;

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
 * The positions of the quick-access menu. Pro has one per favorite, up to five. Without Pro the
 * first three are usable and the last two are always shown, locked, so the way up is visible.
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

/** The recipe for the site a favorite opens, when one is installed. */
export function recipeForFavorite<T extends { homepage: string | null }>(
  sites: readonly T[],
  favoriteUrl: string,
): T | undefined {
  const site = siteOf(favoriteUrl);
  if (!site) return undefined;
  return sites.find((entry) => entry.homepage !== null && siteOf(entry.homepage) === site);
}

/**
 * The favorites with this site's entry added or taken away. The other favorites keep their names,
 * notify choices and order, and the new entry goes last, so the quick-access menu does not jump
 * around.
 */
export function toggleSiteFavorite(
  favorites: readonly FavoriteInput[],
  url: string,
): FavoriteInput[] {
  const site = siteOf(url);
  if (!site) return favorites.map(asInput);
  const kept = favorites.filter((favorite) => siteOf(favorite.url) !== site).map(asInput);
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

/** What the library takes for a favorite: the id and icon are Rust's to keep. */
export const asInput = ({ name, url, notify, landing, folder }: FavoriteInput): FavoriteInput => ({
  name,
  url,
  notify,
  landing,
  folder,
});

/** Two names are the same folder when they differ only in case or surrounding space. */
export const folderKey = (folder: string | null | undefined): string | null => {
  const key = folder?.trim().toLowerCase();
  return key ? key : null;
};

/** One line of a favorites list: a favorite on its own, or a folder standing for several. */
export type FavoriteEntry<T> =
  | { kind: "favorite"; favorite: T; index: number }
  | { kind: "folder"; name: string; members: { favorite: T; index: number }[] };

/**
 * The favorites as a list shows them. `shown` are the indexes into `favorites` the list has room
 * for, in order. A favorite with a folder is replaced by its folder, at the place of the first of
 * its favorites that is shown, and the folder holds every favorite filed in it, shown or not, so
 * opening it reaches them all. A folder none of whose favorites is shown is not listed.
 */
export function groupByFolder<T extends { folder?: string | null }>(
  favorites: readonly T[],
  shown: readonly number[] = favorites.map((_, index) => index),
): FavoriteEntry<T>[] {
  const entries: FavoriteEntry<T>[] = [];
  const listed = new Set<string>();
  for (const index of shown) {
    const favorite = favorites[index];
    const key = folderKey(favorite.folder);
    if (key === null) {
      entries.push({ kind: "favorite", favorite, index });
    } else if (!listed.has(key)) {
      listed.add(key);
      entries.push({
        kind: "folder",
        name: favorite.folder?.trim() ?? "",
        members: favorites.flatMap((member, at) =>
          folderKey(member.folder) === key ? [{ favorite: member, index: at }] : [],
        ),
      });
    }
  }
  return entries;
}

/** The folder names in use, each once, in list order. */
export function folderNames(favorites: readonly { folder?: string | null }[]): string[] {
  const names = new Map<string, string>();
  for (const { folder } of favorites) {
    const key = folderKey(folder);
    if (key !== null && !names.has(key)) names.set(key, folder?.trim() ?? "");
  }
  return [...names.values()];
}

/** The address a new session of a favorite starts at: its landing page when it has one, else its address. */
export function favoriteStartUrl(favorite: { url: string; landing?: string | null }): string {
  return favorite.landing || favorite.url;
}

/**
 * What a favorite's landing field means: `null` for blank (the favorite opens its address), the
 * address for an http(s) address or a `/path` on the favorite's own origin that stays on the
 * favorite's site, and `undefined` for anything else. Rust checks it again and is the authority;
 * this only lets the editor say so before saving.
 */
export function resolveLanding(input: string, favoriteUrl: string): string | null | undefined {
  const text = input.trim();
  if (text === "") return null;
  if (/\s/.test(text)) return undefined;
  let landing: URL;
  try {
    landing =
      text.startsWith("/") && !text.startsWith("//") ? new URL(text, favoriteUrl) : new URL(text);
  } catch {
    return undefined;
  }
  if (landing.protocol !== "https:" && landing.protocol !== "http:") return undefined;
  const site = siteOf(favoriteUrl);
  return site !== null && siteOf(landing.href) === site ? landing.href : undefined;
}

/** The name a new favorite gets: the site's host, or the site it belongs to, short enough for the library to accept. */
function favoriteName(url: string): string {
  const host = displayHost(url);
  if (host.length <= MAX_FAVORITE_NAME_CHARS) return host;
  const site = siteOf(url);
  if (site && site.length <= MAX_FAVORITE_NAME_CHARS) return site;
  return host.slice(0, MAX_FAVORITE_NAME_CHARS);
}
