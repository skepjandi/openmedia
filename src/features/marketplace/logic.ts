import { hostOf, registrableDomain, siteOf } from "../../shared/site";
import type { MarketComment, MarketItem, MarketRating, MarketTag } from "./ipc";

const ORIGIN_TAGS: readonly MarketTag[] = ["official", "community"];
const PLATFORM_TAGS: readonly MarketTag[] = ["mobile", "desktop"];
const HUB_TAGS: readonly MarketTag[] = ["hub"];

/** The chips, in the order they are shown. */
export const FILTER_TAGS: readonly MarketTag[] = [
  "official",
  "community",
  "mobile",
  "desktop",
  "hub",
];

export const MAX_COMMENT_CHARS = 280;
export const STAR_COUNT = 5;

/** The tags the shell knows how to show; anything else the server adds is left out. */
export function knownTags(tags: readonly string[]): MarketTag[] {
  return FILTER_TAGS.filter((tag) => tags.includes(tag));
}

/** Mobile on phones and tablets, desktop otherwise: the recipes written for the screen in hand. */
export function platformTag(userAgent: string, touchPoints: number): MarketTag {
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return "mobile";
  // iPadOS reports a Mac user agent but has a touch screen.
  if (/Macintosh/i.test(userAgent) && touchPoints > 1) return "mobile";
  return "desktop";
}

/** What the list shows at first: official recipes for this device. */
export function defaultFilter(platform: MarketTag): ReadonlySet<MarketTag> {
  return new Set<MarketTag>(["official", platform]);
}

export function toggleTag(filter: ReadonlySet<MarketTag>, tag: MarketTag): Set<MarketTag> {
  const next = new Set(filter);
  if (!next.delete(tag)) next.add(tag);
  return next;
}

/**
 * Tags of one kind (origin, platform, or content type) widen the match; kinds narrow each other.
 * A kind with no chip on does not restrict anything.
 */
export function matchesFilter(tags: readonly string[], filter: ReadonlySet<MarketTag>): boolean {
  return [ORIGIN_TAGS, PLATFORM_TAGS, HUB_TAGS].every((kind) => {
    const active = kind.filter((tag) => filter.has(tag));
    return active.length === 0 || active.some((tag) => tags.includes(tag));
  });
}

/**
 * True when every word of the query appears, case-insensitively and literally, in the item's name,
 * author, summary, hosts or tags. A blank query matches everything.
 */
export function matchesSearch(item: MarketItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [item.name, item.author, item.summary, ...item.hosts, ...item.tags]
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * The items the filter and the search let through, official ones first; each group keeps the
 * server's order.
 */
export function visibleItems(
  items: readonly MarketItem[],
  filter: ReadonlySet<MarketTag>,
  query = "",
): MarketItem[] {
  const shown = items.filter(
    (item) => matchesFilter(item.tags, filter) && matchesSearch(item, query),
  );
  const rank = (item: MarketItem) => (item.tags.includes("official") ? 0 : 1);
  return shown
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** Up to three installable or updatable recipes for the page the user is browsing. */
export function recommendedItems(items: readonly MarketItem[], pageUrl: string): MarketItem[] {
  const pageSite = siteOf(pageUrl);
  if (!pageSite) return [];
  return visibleItems(items, new Set<MarketTag>())
    .filter((item) => {
      if (item.installedVersion && !item.updateAvailable) return false;
      const hosts = [
        ...item.hosts.map((host) => hostOf(`https://${host.replace(/^\*\./, "")}`)),
        ...(item.homepage ? [hostOf(item.homepage)] : []),
      ];
      return hosts.some((host) => host !== undefined && registrableDomain(host) === pageSite);
    })
    .slice(0, 3);
}

/** `★ 4.3 (12)`, or null while nobody has rated enough for an average. */
export function formatRating(rating: MarketRating | null): string | null {
  if (!rating || rating.average === null || rating.count <= 0) return null;
  return `★ ${rating.average.toFixed(1)} (${rating.count})`;
}

/** The comment as it will be sent: trimmed. Null when it is empty or too long. */
export function commentToSend(text: string): string | null {
  const trimmed = text.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= MAX_COMMENT_CHARS ? trimmed : null;
}

/** The comments to show: Rust already left out blocked people, this covers one blocked a moment ago. */
export function withoutBlocked(
  comments: readonly MarketComment[],
  blocked: ReadonlySet<string>,
): MarketComment[] {
  return comments.filter((comment) => comment.mine || !blocked.has(comment.commenter));
}

export type MarketView =
  { kind: "list" } | { kind: "detail"; id: string } | { kind: "submit" } | { kind: "blocked" };

/** Where the back button goes: every page returns to the list, and the list closes the screen. */
export function backTarget(view: MarketView): MarketView | "close" {
  return view.kind === "list" ? "close" : { kind: "list" };
}
