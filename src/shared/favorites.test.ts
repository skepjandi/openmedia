import { describe, expect, it } from "vitest";
import {
  MAX_FAVORITE_NAME_CHARS,
  QUICK_ACCESS_LIMIT,
  asInput,
  displayHost,
  favoriteStartUrl,
  isFavoriteSite,
  quickAccess,
  quickSlots,
  recipeForFavorite,
  resolveLanding,
  toggleSiteFavorite,
  usableQuickAccess,
} from "./favorites";

describe("quickAccess", () => {
  it("keeps the first favorites in order and leaves the rest out", () => {
    const favorites = Array.from({ length: QUICK_ACCESS_LIMIT + 4 }, (_, index) => index);
    expect(quickAccess(favorites)).toEqual(favorites.slice(0, QUICK_ACCESS_LIMIT));
  });

  it("shows everything when there are few favorites", () => {
    expect(quickAccess(["a", "b"])).toEqual(["a", "b"]);
    expect(quickAccess([])).toEqual([]);
  });
});

describe("quickSlots", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("gives Pro one usable slot per favorite, up to six", () => {
    expect(quickSlots(names, true)).toEqual(
      names.slice(0, 6).map((favorite) => ({ favorite, locked: false })),
    );
    expect(quickSlots(["a"], true)).toEqual([{ favorite: "a", locked: false }]);
  });

  it("gives a free user four usable slots and two locked ones holding the next favorites", () => {
    expect(quickSlots(names, false)).toEqual([
      { favorite: "a", locked: false },
      { favorite: "b", locked: false },
      { favorite: "c", locked: false },
      { favorite: "d", locked: false },
      { favorite: "e", locked: true },
      { favorite: "f", locked: true },
    ]);
  });

  it("always shows the two locked slots to a free user, empty when there is nothing for them", () => {
    expect(quickSlots(["a", "b"], false)).toEqual([
      { favorite: "a", locked: false },
      { favorite: "b", locked: false },
      { favorite: null, locked: true },
      { favorite: null, locked: true },
    ]);
  });

  it("lists only what a free user can open", () => {
    expect(usableQuickAccess(names, false)).toEqual(["a", "b", "c", "d"]);
    expect(usableQuickAccess(names, true)).toEqual(names.slice(0, 6));
  });
});

describe("displayHost", () => {
  it("drops the www every site adds", () => {
    expect(displayHost("https://www.reddit.com/r/rust")).toBe("reddit.com");
    expect(displayHost("https://m.youtube.com/")).toBe("m.youtube.com");
    expect(displayHost("nonsense")).toBe("nonsense");
  });
});

describe("isFavoriteSite", () => {
  const favorites = [
    { name: "Reddit", url: "https://www.reddit.com/" },
    { name: "YouTube", url: "https://m.youtube.com/" },
  ];

  it("knows a site that is already a favorite", () => {
    expect(isFavoriteSite(favorites, "https://www.reddit.com/r/rust")).toBe(true);
    expect(isFavoriteSite(favorites, "https://old.reddit.com/")).toBe(true);
    expect(isFavoriteSite(favorites, "https://youtube.com/watch?v=1")).toBe(true);
  });

  it("knows a site that is not", () => {
    expect(isFavoriteSite(favorites, "https://example.com/")).toBe(false);
    expect(isFavoriteSite(favorites, "not a url")).toBe(false);
  });
});

describe("toggleSiteFavorite", () => {
  const favorites = [
    { name: "Reddit", url: "https://www.reddit.com/" },
    { name: "YouTube", url: "https://m.youtube.com/" },
  ];

  it("adds the site last and keeps the other favorites in order", () => {
    expect(toggleSiteFavorite(favorites, "https://example.com/page")).toEqual([
      { name: "Reddit", url: "https://www.reddit.com/" },
      { name: "YouTube", url: "https://m.youtube.com/" },
      { name: "example.com", url: "https://example.com/" },
    ]);
  });

  it("keeps a favorite's notify choice when another site is starred or unstarred", () => {
    const quiet = [{ name: "Reddit", url: "https://www.reddit.com/", notify: false }];
    const added = toggleSiteFavorite(quiet, "https://example.com/");
    expect(added[0].notify).toBe(false);
    expect(toggleSiteFavorite(added, "https://example.com/")).toEqual(quiet);
  });

  it("takes the site's favorite away instead of adding a second one", () => {
    expect(toggleSiteFavorite(favorites, "https://old.reddit.com/r/rust")).toEqual([
      { name: "YouTube", url: "https://m.youtube.com/" },
    ]);
  });

  it("does not add the same site twice", () => {
    const once = toggleSiteFavorite(favorites, "https://example.com/");
    expect(toggleSiteFavorite(once, "https://example.com/other")).toEqual([
      { name: "Reddit", url: "https://www.reddit.com/" },
      { name: "YouTube", url: "https://m.youtube.com/" },
    ]);
  });

  it("keeps the name short enough for the library to accept it", () => {
    const added = toggleSiteFavorite([], "https://a-very-long-subdomain.example.com/page");
    expect(added[0].name.length).toBeLessThanOrEqual(MAX_FAVORITE_NAME_CHARS);
    expect(added[0].name).toBe("example.com");
  });

  it("leaves the favorites alone for an address that is not one", () => {
    expect(toggleSiteFavorite(favorites, "not a url")).toEqual([
      { name: "Reddit", url: "https://www.reddit.com/" },
      { name: "YouTube", url: "https://m.youtube.com/" },
    ]);
  });
});

describe("recipeForFavorite", () => {
  const sites = [
    { id: "a", homepage: "https://www.instagram.com/" },
    { id: "b", homepage: null },
    { id: "c", homepage: "https://alice.github.io/" },
  ];

  it("finds the recipe of the same site, whatever the subdomain", () => {
    expect(recipeForFavorite(sites, "https://m.instagram.com/explore")?.id).toBe("a");
  });

  it("finds nothing for a site without a recipe or a recipe without a homepage", () => {
    expect(recipeForFavorite(sites, "https://example.org/")).toBeUndefined();
    expect(recipeForFavorite(sites, "not a url")).toBeUndefined();
    expect(recipeForFavorite(sites, "https://bob.github.io/")).toBeUndefined();
  });
});

describe("landing pages", () => {
  const home = "https://m.youtube.com/";

  it("opens the address unless the favorite has a landing page", () => {
    expect(favoriteStartUrl({ url: home })).toBe(home);
    expect(favoriteStartUrl({ url: home, landing: null })).toBe(home);
    expect(favoriteStartUrl({ url: home, landing: "" })).toBe(home);
    expect(favoriteStartUrl({ url: home, landing: "https://m.youtube.com/feed" })).toBe(
      "https://m.youtube.com/feed",
    );
  });

  it("reads a blank field as none, so clearing it returns the favorite to its address", () => {
    expect(resolveLanding("", home)).toBeNull();
    expect(resolveLanding("   ", home)).toBeNull();
  });

  it("takes a path or an address on the favorite's own site", () => {
    expect(resolveLanding("/feed/subscriptions", home)).toBe(
      "https://m.youtube.com/feed/subscriptions",
    );
    expect(resolveLanding("https://www.youtube.com/feed", home)).toBe(
      "https://www.youtube.com/feed",
    );
  });

  it("refuses another site, another scheme and text that is not an address", () => {
    for (const input of [
      "https://evil.example/",
      "//evil.example/",
      "javascript:alert(1)",
      "ftp://m.youtube.com/",
      "/a b",
      "not a url",
    ]) {
      expect(resolveLanding(input, home), input).toBeUndefined();
    }
  });

  it("keeps a favorite's landing page when the list is rewritten", () => {
    const favorite = { name: "YouTube", url: home, notify: true, landing: "/feed" };
    expect(asInput(favorite)).toEqual(favorite);
    const kept = toggleSiteFavorite([favorite], "https://example.com/");
    expect(kept[0]?.landing).toBe("/feed");
  });
});
