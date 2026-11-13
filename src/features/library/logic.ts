import type { CategoryTag, LibraryItem, LibraryTag } from "./ipc";

const ORIGIN_TAGS: readonly LibraryTag[] = ["official", "community"];
const PLATFORM_TAGS: readonly LibraryTag[] = ["mobile", "desktop"];
const HUB_TAGS: readonly LibraryTag[] = ["hub"];
const STATUS_TAGS: readonly LibraryTag[] = ["notAdded", "added", "updatable"];

/** The subject categories, in the order the filter dialog lists them. */
export const CATEGORY_TAGS: readonly CategoryTag[] = [
  "ai",
  "archive",
  "education",
  "games",
  "music",
  "news",
  "podcasts",
  "productivity",
  "radio",
  "reference",
  "search",
  "shopping",
  "social",
  "tech",
  "travel",
  "video",
];

/** The tags a row shows as badges, in the order they are shown. */
export const FILTER_TAGS: readonly LibraryTag[] = [
  "official",
  "community",
  "mobile",
  "desktop",
  "hub",
];

/** The filter dialog's sections: each kind widens within itself and narrows the others. */
export const FILTER_KINDS = [
  { id: "origin", tags: ORIGIN_TAGS },
  { id: "platform", tags: PLATFORM_TAGS },
  { id: "type", tags: HUB_TAGS },
  { id: "status", tags: STATUS_TAGS },
  { id: "category", tags: CATEGORY_TAGS },
] as const;

/** The tags the shell knows how to show; anything else is left out. */
export function knownTags(tags: readonly string[]): LibraryTag[] {
  return [...FILTER_TAGS, ...CATEGORY_TAGS].filter((tag) => tags.includes(tag));
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

/** Where the recipe stands on this device: not added, added, or added with a newer version here. */
function statusTag(item: LibraryItem): LibraryTag {
  if (!item.installedVersion) return "notAdded";
  return item.updateAvailable ? "updatable" : "added";
}

/**
 * Tags of one kind (origin, platform, type, status or category) widen the match; kinds narrow
 * each other. A kind with no chip on does not restrict anything. `skip` leaves one kind out.
 */
function matchesKinds(
  has: (tag: LibraryTag) => boolean,
  filter: ReadonlySet<LibraryTag>,
  skip?: string,
): boolean {
  if (filter.size === 0) return true;
  return FILTER_KINDS.every(({ id, tags: kind }) => {
    if (id === skip) return true;
    let restricted = false;
    for (const tag of kind) {
      if (!filter.has(tag)) continue;
      if (has(tag)) return true;
      restricted = true;
    }
    return !restricted;
  });
}

export function matchesFilter(tags: readonly string[], filter: ReadonlySet<LibraryTag>): boolean {
  return matchesKinds((tag) => tags.includes(tag), filter);
}

const searchWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

const searchText = (item: LibraryItem): string =>
  [item.name, item.author, item.summary, ...item.hosts, ...item.tags].join("\n").toLowerCase();

/**
 * True when every word of the query appears, case-insensitively and literally, in the item's name,
 * author, summary, hosts or tags. A blank query matches everything.
 */
export function matchesSearch(item: LibraryItem, query: string): boolean {
  const words = searchWords(query);
  if (words.length === 0) return true;
  const haystack = searchText(item);
  return words.every((word) => haystack.includes(word));
}

/** A recipe with everything the filter and the search need worked out once. */
export interface IndexedItem {
  item: LibraryItem;
  tags: ReadonlySet<string>;
  text: string;
}

/**
 * The list prepared for filtering: official recipes first, each group in the list's order, with
 * every item's tags and search text computed once. Filtering and counting then never look at an
 * item's strings again, so typing in the search stays cheap with hundreds of recipes.
 */
export function indexItems(items: readonly LibraryItem[]): IndexedItem[] {
  const indexed = items.map((item) => ({
    item,
    tags: new Set([...item.tags, statusTag(item)]),
    text: searchText(item),
  }));
  const official = indexed.filter((entry) => entry.tags.has("official"));
  const others = indexed.filter((entry) => !entry.tags.has("official"));
  return [...official, ...others];
}

const passes = (
  entry: IndexedItem,
  filter: ReadonlySet<LibraryTag>,
  words: readonly string[],
  skip?: string,
): boolean =>
  matchesKinds((tag) => entry.tags.has(tag), filter, skip) &&
  words.every((word) => entry.text.includes(word));

/** The indexed items the filter and the search let through, in index order. */
export function visibleIndexed(
  index: readonly IndexedItem[],
  filter: ReadonlySet<LibraryTag>,
  query = "",
): IndexedItem[] {
  const words = searchWords(query);
  return index.filter((entry) => passes(entry, filter, words));
}

/**
 * For every tag, how many items the list would show if it were switched on, given the other
 * kinds' chips and the search. A kind's own chips are ignored, so a chip never counts itself
 * away. One pass per kind, however many tags it has.
 */
export function facetCounts(
  index: readonly IndexedItem[],
  filter: ReadonlySet<LibraryTag>,
  query = "",
): Map<LibraryTag, number> {
  const words = searchWords(query);
  const counts = new Map<LibraryTag, number>();
  for (const { id, tags: kind } of FILTER_KINDS) {
    for (const tag of kind) counts.set(tag, 0);
    for (const entry of index) {
      if (!passes(entry, filter, words, id)) continue;
      for (const tag of kind) {
        if (entry.tags.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
  }
  return counts;
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
  return visibleIndexed(indexItems(items), filter, query).map(({ item }) => item);
}

/** How many items the list would show if `tag` were switched on; see `facetCounts`. */
export function facetCount(
  items: readonly LibraryItem[],
  filter: ReadonlySet<LibraryTag>,
  tag: LibraryTag,
  query = "",
): number {
  return facetCounts(indexItems(items), filter, query).get(tag) ?? 0;
}

/** The chips on, for the badge on the filter button. */
export function activeFilterCount(filter: ReadonlySet<LibraryTag>): number {
  return filter.size;
}

/** The filter's chips in the dialog's order, so the summary under the search reads the same way. */
export function activeTags(filter: ReadonlySet<LibraryTag>): LibraryTag[] {
  return FILTER_KINDS.flatMap(({ tags }) => tags.filter((tag) => filter.has(tag)));
}

export type LibraryView = { kind: "list" } | { kind: "detail"; id: string };

/** Where the back button goes: every page returns to the list, and the list closes the screen. */
export function backTarget(view: LibraryView): LibraryView | "close" {
  return view.kind === "list" ? "close" : { kind: "list" };
}

/** How many rows the list draws at first and each time the reader reaches the end. */
export const PAGE_SIZE = 30;
