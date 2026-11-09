import { describe, expect, it } from "vitest";
import { isSearchPage, leftSearchForSite } from "./searchVisit";

describe("leftSearchForSite", () => {
  it("records a site opened from a search result, for every engine", () => {
    for (const results of [
      "https://duckduckgo.com/?q=cats",
      "https://www.google.com/search?q=cats",
      "https://www.bing.com/search?q=cats",
      "https://search.brave.com/search?q=cats",
      "https://www.ecosia.org/search?q=cats",
      "https://www.startpage.com/sp/search?query=cats",
      "https://search.yahoo.com/search?p=cats",
    ]) {
      expect(leftSearchForSite(results, "https://example.com/cats")).toBe(true);
    }
  });

  it("does not record the search itself, a search page after a search page, or the first page", () => {
    expect(leftSearchForSite(null, "https://duckduckgo.com/?q=cats")).toBe(false);
    expect(
      leftSearchForSite("https://duckduckgo.com/?q=cats", "https://duckduckgo.com/?q=dogs"),
    ).toBe(false);
    expect(leftSearchForSite(null, "https://example.com/")).toBe(false);
  });

  it("does not record moving around inside the site after the first visit", () => {
    expect(leftSearchForSite("https://example.com/cats", "https://example.com/dogs")).toBe(false);
    expect(leftSearchForSite("https://example.com/", "https://duckduckgo.com/?q=x")).toBe(false);
  });

  it("ignores non-web addresses", () => {
    expect(leftSearchForSite("https://duckduckgo.com/?q=cats", "about:blank")).toBe(false);
  });
});

describe("isSearchPage", () => {
  it("matches the engine's host, with or without www, and nothing else on its site family", () => {
    expect(isSearchPage("https://google.com/search?q=a")).toBe(true);
    expect(isSearchPage("https://www.google.com/search?q=a")).toBe(true);
    expect(isSearchPage("https://brave.com/download")).toBe(false);
  });
});
