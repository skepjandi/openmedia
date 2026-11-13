import { describe, expect, it } from "vitest";
import type { LibraryItem, LibraryTag } from "./ipc";
import {
  activeTags,
  backTarget,
  defaultFilter,
  facetCount,
  facetCounts,
  indexItems,
  knownTags,
  matchesFilter,
  matchesSearch,
  platformTag,
  toggleTag,
  visibleIndexed,
  visibleItems,
  SHELF_SIZE,
  shelfOf,
} from "./logic";

const item = (id: string, tags: string[]): LibraryItem => ({
  id,
  name: id,
  version: "1.0.0",
  author: "a",
  summary: "",
  hosts: [],
  installedVersion: null,
  updateAvailable: false,
  tags,
  homepage: null,
  popularRank: null,
  isNew: false,
});

describe("discover", () => {
  const items = [
    { ...item("c", ["official", "mobile"]), popularRank: 2 },
    item("plain", ["official", "mobile"]),
    { ...item("a", ["official", "mobile"]), popularRank: 0, isNew: true },
    { ...item("b", ["official", "mobile"]), popularRank: 1, installedVersion: "1.0.0" },
    { ...item("fresh", ["official", "mobile"]), isNew: true },
    { ...item("other", ["community", "mobile"]), popularRank: 3 },
  ];
  const index = indexItems(items);
  const on = (...tags: LibraryTag[]): ReadonlySet<LibraryTag> => new Set(tags);

  it("filters by the maintainers' popular list and the latest release", () => {
    const ids = (tags: ReadonlySet<LibraryTag>) =>
      visibleIndexed(index, tags).map(({ item: entry }) => entry.id);
    expect(ids(on("new"))).toEqual(["a", "fresh"]);
    expect(ids(on("popular", "official")).sort()).toEqual(["a", "b", "c"]);
  });

  it("lists popular recipes in the popular order, not the library's", () => {
    const order = visibleIndexed(index, on("popular")).map(({ item: entry }) => entry.id);
    expect(order).toEqual(["a", "b", "c", "other"]);
  });

  it("builds shelves from what is not added yet, popular first and capped", () => {
    const shown = visibleIndexed(index, on("official"));
    expect(shelfOf(shown, "popular").map(({ item: entry }) => entry.id)).toEqual(["a", "c"]);
    expect(shelfOf(shown, "new").map(({ item: entry }) => entry.id)).toEqual(["a", "fresh"]);
    const many = indexItems(
      Array.from({ length: SHELF_SIZE + 5 }, (_, rank) => ({
        ...item(`r${rank}`, ["official"]),
        popularRank: rank,
      })),
    );
    expect(shelfOf(many, "popular")).toHaveLength(SHELF_SIZE);
  });

  it("counts the discover chips like any other", () => {
    const counts = facetCounts(index, on("official"));
    expect(counts.get("popular")).toBe(3);
    expect(counts.get("new")).toBe(2);
  });
});

describe("status filter", () => {
  const items = [
    item("fresh", ["official", "mobile"]),
    { ...item("have", ["official", "mobile"]), installedVersion: "1.0.0" },
    { ...item("old", ["official", "mobile"]), installedVersion: "0.9.0", updateAvailable: true },
  ];

  it("separates what is not added, added and out of date", () => {
    const ids = (tag: "notAdded" | "added" | "updatable") =>
      visibleItems(items, new Set([tag])).map((entry) => entry.id);
    expect(ids("notAdded")).toEqual(["fresh"]);
    expect(ids("added")).toEqual(["have"]);
    expect(ids("updatable")).toEqual(["old"]);
  });

  it("widens within the status kind and narrows against the others", () => {
    const filter = new Set(["notAdded", "updatable", "desktop"] as const);
    expect(visibleItems(items, filter)).toEqual([]);
    expect(
      visibleItems(items, new Set(["notAdded", "updatable", "mobile"] as const)).map((e) => e.id),
    ).toEqual(["fresh", "old"]);
  });
});

describe("facetCounts", () => {
  const items = [
    item("a", ["official", "mobile", "music"]),
    item("b", ["official", "mobile", "radio"]),
    item("c", ["community", "desktop", "music"]),
    { ...item("d", ["official", "desktop", "news"]), installedVersion: "1.0.0" },
  ];

  it("agrees with counting each chip on its own, for every tag and any search", () => {
    const index = indexItems(items);
    const filter = new Set(["official", "music", "radio"] as const);
    for (const query of ["", "a", "zzz"]) {
      const counts = facetCounts(index, filter, query);
      for (const [tag, count] of counts) {
        expect(count, `${tag} for "${query}"`).toBe(facetCount(items, filter, tag, query));
      }
    }
  });

  it("counts the whole library for a tag when nothing else narrows it", () => {
    const counts = facetCounts(indexItems(items), new Set());
    expect(counts.get("official")).toBe(3);
    expect(counts.get("music")).toBe(2);
    expect(counts.get("added")).toBe(1);
    expect(counts.get("notAdded")).toBe(3);
  });
});

describe("indexItems", () => {
  it("puts official recipes first and keeps the list order inside each group", () => {
    const index = indexItems([
      item("c1", ["community"]),
      item("o1", ["official"]),
      item("c2", ["community"]),
      item("o2", ["official"]),
    ]);
    expect(index.map(({ item: entry }) => entry.id)).toEqual(["o1", "o2", "c1", "c2"]);
    expect(visibleIndexed(index, new Set(["community"])).map(({ item: e }) => e.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("lists the chips that are on in the dialog's order", () => {
    expect(activeTags(new Set(["music", "mobile", "added", "official"] as const))).toEqual([
      "official",
      "mobile",
      "added",
      "music",
    ]);
  });
});

describe("platformTag", () => {
  it("is mobile on phones and tablets and desktop elsewhere", () => {
    expect(platformTag("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", 5)).toBe("mobile");
    expect(platformTag("Mozilla/5.0 (Linux; Android 15)", 5)).toBe("mobile");
    expect(platformTag("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("mobile");
    expect(platformTag("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("desktop");
  });
});

describe("tag filter", () => {
  it("starts on official recipes for this platform", () => {
    expect([...defaultFilter("mobile")].sort()).toEqual(["mobile", "official"]);
  });

  it("toggles a chip without changing the original", () => {
    const filter = defaultFilter("desktop");
    const next = toggleTag(filter, "community");
    expect(next.has("community")).toBe(true);
    expect(filter.has("community")).toBe(false);
    expect(toggleTag(next, "community").has("community")).toBe(false);
  });

  it("combines the hub type filter with platform and origin", () => {
    const filter = new Set(["community", "mobile", "hub"] as const);
    expect(matchesFilter(["community", "mobile", "hub"], filter)).toBe(true);
    expect(matchesFilter(["community", "mobile"], filter)).toBe(false);
    expect(matchesFilter(["official", "mobile", "hub"], filter)).toBe(false);
  });

  it("lets everything through when no chip is on", () => {
    expect(matchesFilter(["community", "desktop"], new Set())).toBe(true);
  });

  it("lists official recipes first and keeps the list order inside each group", () => {
    const items = [
      item("c1", ["community", "mobile"]),
      item("o1", ["official", "mobile"]),
      item("c2", ["community", "mobile"]),
      item("o2", ["official", "mobile"]),
      item("o3", ["official", "desktop"]),
    ];
    const shown = visibleItems(items, new Set(["official", "community", "mobile"] as const));
    expect(shown.map((entry) => entry.id)).toEqual(["o1", "o2", "c1", "c2"]);
  });

  it("widens within the categories and narrows against the other kinds", () => {
    const items = [
      item("a", ["mobile", "music", "official"]),
      item("b", ["mobile", "radio", "official"]),
      item("c", ["mobile", "news", "official"]),
      item("d", ["desktop", "music", "official"]),
    ];
    const filter = new Set(["mobile", "music", "radio"] as const);
    expect(visibleItems(items, filter).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("counts a chip against the other kinds only, so its own kind never hides it", () => {
    const items = [
      item("a", ["mobile", "music", "official"]),
      item("b", ["mobile", "radio", "official"]),
      item("d", ["desktop", "music", "official"]),
    ];
    const filter = new Set(["mobile", "music"] as const);
    expect(facetCount(items, filter, "radio")).toBe(1);
    expect(facetCount(items, filter, "music")).toBe(1);
    expect(facetCount(items, filter, "desktop")).toBe(1);
    expect(facetCount(items, filter, "music", "no such")).toBe(0);
  });

  it("ignores tags the app does not know", () => {
    expect(knownTags(["mobile", "beta", "official", "hub"])).toEqual(["official", "mobile", "hub"]);
    expect(knownTags(["video", "mobile", "music"])).toEqual(["mobile", "music", "video"]);
  });
});

describe("backTarget", () => {
  it("returns every page to the list and closes from the list", () => {
    expect(backTarget({ kind: "detail", id: "x" })).toEqual({ kind: "list" });
    expect(backTarget({ kind: "list" })).toBe("close");
  });
});

describe("matchesSearch", () => {
  const found: LibraryItem = {
    ...item("x", ["official", "desktop"]),
    name: "Discord Web",
    author: "OpenMedia",
    summary: "Chat on the web",
    hosts: ["discord.com", "*.discord.gg"],
  };

  it("matches every word in any field, in any order", () => {
    expect(matchesSearch(found, "chat discord")).toBe(true);
    expect(matchesSearch(found, "openmedia web")).toBe(true);
    expect(matchesSearch(found, "discord telegram")).toBe(false);
  });

  it("ignores case and surrounding space", () => {
    expect(matchesSearch(found, "  DISCORD  ")).toBe(true);
  });

  it("matches tags and hosts", () => {
    expect(matchesSearch(found, "official")).toBe(true);
    expect(matchesSearch(found, "discord.gg")).toBe(true);
    expect(matchesSearch(found, "community")).toBe(false);
  });

  it("matches everything when the query is blank", () => {
    expect(matchesSearch(found, "")).toBe(true);
    expect(matchesSearch(found, "   ")).toBe(true);
  });

  it("treats regular-expression characters literally", () => {
    expect(matchesSearch(found, ".*")).toBe(false);
    expect(matchesSearch(found, "(")).toBe(false);
    expect(matchesSearch(found, "[a-z]+")).toBe(false);
    expect(matchesSearch({ ...found, summary: "C++ (beta)" }, "c++ (beta)")).toBe(true);
  });

  it("combines with the tag filter", () => {
    const items = [found, { ...item("y", ["community", "desktop"]), name: "Discord Lite" }];
    const filter = new Set(["official"] as const);
    expect(visibleItems(items, filter, "discord").map((entry) => entry.id)).toEqual(["x"]);
    expect(visibleItems(items, new Set(), "lite").map((entry) => entry.id)).toEqual(["y"]);
    expect(visibleItems(items, filter, "lite")).toEqual([]);
  });
});
