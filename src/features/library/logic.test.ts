import { describe, expect, it } from "vitest";
import type { LibraryItem } from "./ipc";
import {
  backTarget,
  defaultFilter,
  facetCount,
  knownTags,
  matchesFilter,
  matchesSearch,
  platformTag,
  toggleTag,
  visibleItems,
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
