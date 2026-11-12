import type { LibraryItem, LibraryTag } from "./ipc";

const ORIGIN_TAGS: readonly LibraryTag[] = ["official", "community"];
const PLATFORM_TAGS: readonly LibraryTag[] = ["mobile", "desktop"];
const HUB_TAGS: readonly LibraryTag[] = ["hub"];

/** The chips, in the order they are shown. */
export const FILTER_TAGS: readonly LibraryTag[] = [
  "official",
  "community",
  "mobile",
  "desktop",
  "hub",
];

/** The tags the shell knows how to show; anything else is left out. */
export function knownTags(tags: readonly string[]): LibraryTag[] {
  return FILTER_TAGS.filter((tag) => tags.includes(tag));
}

/** Mobile on phones and tablets, desktop otherwise: the recipes written for the screen in hand. */
export function platformTag(userAgent: string, touchPoints: number): LibraryTag {
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return "mobile";
  // iPadOS reports a Mac user agent but has a touch screen.
  if (/Macintosh/i.test(userAgent) && touchPoints > 1) return "mobile";
  return "desktop";
}

/** What the list shows at first: official recipes for this device. */
export function defaultFilter(platform: LibraryTag): ReadonlySet<LibraryTag> {
  return new Set<LibraryTag>(["official", platform]);
}

export function toggleTag(filter: ReadonlySet<LibraryTag>, tag: LibraryTag): Set<LibraryTag> {
  const next = new Set(filter);
  if (!next.delete(tag)) next.add(tag);
  return next;
}

/**
 * Tags of one kind (origin, platform, or content type) widen the match; kinds narrow each other.
 * A kind with no chip on does not restrict anything.
 */
export function matchesFilter(tags: readonly string[], filter: ReadonlySet<LibraryTag>): boolean {
  return [ORIGIN_TAGS, PLATFORM_TAGS, HUB_TAGS].every((kind) => {
    const active = kind.filter((tag) => filter.has(tag));
    return active.length === 0 || active.some((tag) => tags.includes(tag));
  });
}

/**
 * True when every word of the query appears, case-insensitively and literally, in the item's name,
 * author, summary, hosts or tags. A blank query matches everything.
 */
export function matchesSearch(item: LibraryItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [item.name, item.author, item.summary, ...item.hosts, ...item.tags]
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * The items the filter and the search let through, official ones first; each group keeps the
 * list's order.
 */
export function visibleItems(
  items: readonly LibraryItem[],
  filter: ReadonlySet<LibraryTag>,
  query = "",
): LibraryItem[] {
  const shown = items.filter(
    (item) => matchesFilter(item.tags, filter) && matchesSearch(item, query),
  );
  const rank = (item: LibraryItem) => (item.tags.includes("official") ? 0 : 1);
  return shown
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

export type LibraryView = { kind: "list" } | { kind: "detail"; id: string };

/** Where the back button goes: every page returns to the list, and the list closes the screen. */
export function backTarget(view: LibraryView): LibraryView | "close" {
  return view.kind === "list" ? "close" : { kind: "list" };
}
