import { describe, expect, it } from "vitest";
import type { MarketComment, MarketItem } from "./ipc";
import {
  backTarget,
  commentToSend,
  defaultFilter,
  formatRating,
  knownTags,
  matchesFilter,
  matchesSearch,
  platformTag,
  toggleTag,
  visibleItems,
  withoutBlocked,
} from "./logic";

const item = (id: string, tags: string[]): MarketItem => ({
  id,
  name: id,
  version: "1.0.0",
  author: "a",
  summary: "",
  hosts: [],
  featured: false,
  installs: null,
  installedVersion: null,
  updateAvailable: false,
  tags,
  homepage: null,
  rating: null,
  myRating: null,
});

const comment = (id: string, commenter: string, mine = false): MarketComment => ({
  id,
  commenter,
  text: "hi",
  createdAt: 1,
  mine,
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

  it("lists official recipes first and keeps the server order inside each group", () => {
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

  it("ignores tags the app does not know", () => {
    expect(knownTags(["mobile", "beta", "official", "hub"])).toEqual(["official", "mobile", "hub"]);
  });
});

describe("formatRating", () => {
  it("shows the average and the count", () => {
    expect(formatRating({ average: 4.3, count: 12 })).toBe("★ 4.3 (12)");
    expect(formatRating({ average: 4, count: 7 })).toBe("★ 4.0 (7)");
  });

  it("shows nothing while there is no average or no rating", () => {
    expect(formatRating(null)).toBeNull();
    expect(formatRating({ average: null, count: 3 })).toBeNull();
    expect(formatRating({ average: 5, count: 0 })).toBeNull();
  });
});

describe("commentToSend", () => {
  it("trims and accepts 1 to 280 characters", () => {
    expect(commentToSend("  nice  ")).toBe("nice");
    expect(commentToSend("a".repeat(280))).toHaveLength(280);
  });

  it("refuses empty and too long text", () => {
    expect(commentToSend("   ")).toBeNull();
    expect(commentToSend("a".repeat(281))).toBeNull();
  });

  it("counts characters, not UTF-16 units", () => {
    expect(commentToSend("😀".repeat(280))).not.toBeNull();
    expect(commentToSend("😀".repeat(281))).toBeNull();
  });
});

describe("withoutBlocked", () => {
  it("hides comments from commenters blocked a moment ago", () => {
    const comments = [comment("1", "aaaaaaaaaa"), comment("2", "bbbbbbbbbb")];
    expect(withoutBlocked(comments, new Set(["aaaaaaaaaa"])).map((c) => c.id)).toEqual(["2"]);
  });

  it("never hides the user's own comment", () => {
    const own = comment("1", "aaaaaaaaaa", true);
    expect(withoutBlocked([own], new Set(["aaaaaaaaaa"]))).toEqual([own]);
  });
});

describe("backTarget", () => {
  it("returns every page to the list and closes from the list", () => {
    expect(backTarget({ kind: "detail", id: "x" })).toEqual({ kind: "list" });
    expect(backTarget({ kind: "submit" })).toEqual({ kind: "list" });
    expect(backTarget({ kind: "blocked" })).toEqual({ kind: "list" });
    expect(backTarget({ kind: "list" })).toBe("close");
  });
});

describe("matchesSearch", () => {
  const found: MarketItem = {
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
