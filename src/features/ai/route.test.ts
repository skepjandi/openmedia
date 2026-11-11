import { describe, expect, it } from "vitest";
import { providerReady, routeInput, type RouteContext } from "./route";
import { searchUrl } from "../../shared/searchEngines";
import type { AiState } from "../../shared/ipc";

const provider = (hasKey: boolean) => ({
  id: "p",
  name: "P",
  kind: "anthropic" as const,
  baseUrl: "https://api.anthropic.com",
  model: null,
  hasKey,
});
const ready: AiState = { providers: [provider(true)], activeId: "p" };
const page = "https://www.youtube.com/watch?v=1";
const context = (overrides: Partial<RouteContext> = {}): RouteContext => ({
  ai: ready,
  pageUrl: page,
  pro: true,
  mode: "auto",
  searchEngine: "duckDuckGo",
  ...overrides,
});

describe("routeInput", () => {
  it("is empty for blank text in every mode", () => {
    for (const mode of ["auto", "link", "search", "chat", "hub"] as const) {
      expect(routeInput("   ", context({ mode }))).toEqual({ kind: "empty" });
    }
  });

  describe("auto", () => {
    it("opens addresses for a free user with no provider or page", () => {
      expect(routeInput("youtube.com", context({ ai: null, pageUrl: null, pro: false }))).toEqual({
        kind: "address",
        url: "https://youtube.com/",
      });
    });

    it("searches plain text for a free user", () => {
      expect(routeInput(" cheap flights to rome ", context({ pro: false }))).toEqual({
        kind: "search",
        url: "https://duckduckgo.com/?q=cheap%20flights%20to%20rome",
      });
    });

    it("sends change requests to the assistant", () => {
      expect(routeInput("  hide the suggested videos ", context())).toEqual({
        kind: "request",
        request: "hide the suggested videos",
      });
    });

    it("paywalls a change request for a free user before asking for setup", () => {
      expect(routeInput("hide stories", context({ pro: false, ai: null, pageUrl: null }))).toEqual({
        kind: "paywall",
      });
    });
  });

  describe("link", () => {
    it("opens addresses and rejects other text without paywall or search", () => {
      expect(routeInput("reddit.com", context({ mode: "link", pro: false }))).toEqual({
        kind: "address",
        url: "https://reddit.com/",
      });
      expect(routeInput("hide stories", context({ mode: "link", pro: false }))).toEqual({
        kind: "notLink",
      });
    });
  });

  describe("search", () => {
    it("searches everything, including text that looks like a request or an address", () => {
      expect(routeInput("hide stories", context({ mode: "search", pro: false }))).toEqual({
        kind: "search",
        url: searchUrl("hide stories"),
      });
      expect(routeInput("reddit.com", context({ mode: "search", pro: false }))).toEqual({
        kind: "search",
        url: searchUrl("reddit.com"),
      });
    });

    it("searches with the engine the user picked", () => {
      expect(routeInput("cats", context({ mode: "search", searchEngine: "google" }))).toEqual({
        kind: "search",
        url: "https://www.google.com/search?q=cats",
      });
      expect(routeInput("cats", context({ searchEngine: "yahoo" }))).toEqual({
        kind: "search",
        url: "https://search.yahoo.com/search?p=cats",
      });
    });

    it("encodes the query so it cannot add parameters", () => {
      expect(searchUrl("a&b=c#d")).toBe("https://duckduckgo.com/?q=a%26b%3Dc%23d");
      expect(searchUrl("a&b=c#d", "brave")).toBe("https://search.brave.com/search?q=a%26b%3Dc%23d");
    });
  });

  describe("chat", () => {
    it("always paywalls a free user, even for an address", () => {
      for (const text of ["hide stories", "youtube.com", "cheap flights"]) {
        expect(routeInput(text, context({ mode: "chat", pro: false }))).toEqual({
          kind: "paywall",
        });
      }
    });

    it("sends any text to the assistant for a Pro user", () => {
      expect(routeInput("cheap flights", context({ mode: "chat" }))).toEqual({
        kind: "request",
        request: "cheap flights",
      });
    });

    it("blocks requests without a ready provider", () => {
      const none: AiState = { providers: [provider(false)], activeId: "p" };
      for (const ai of [null, none, { providers: [provider(true)], activeId: null }]) {
        expect(routeInput("hide stories", context({ mode: "chat", ai }))).toEqual({
          kind: "blocked",
          reason: "noProvider",
        });
      }
      expect(providerReady(ready)).toBe(true);
    });

    it("blocks requests with no site page", () => {
      for (const pageUrl of [null, "about:blank"]) {
        expect(routeInput("hide stories", context({ mode: "chat", pageUrl }))).toEqual({
          kind: "blocked",
          reason: "noPage",
        });
      }
    });
  });
  describe("hub", () => {
    it("routes a hub request without a page", () => {
      expect(routeInput("messages across sites", context({ mode: "hub", pageUrl: null }))).toEqual({
        kind: "hub",
        request: "messages across sites",
      });
    });

    it("paywalls free users and requires a provider", () => {
      expect(routeInput("make a hub", context({ mode: "hub", pro: false }))).toEqual({
        kind: "paywall",
      });
      expect(routeInput("make a hub", context({ mode: "hub", ai: null, pageUrl: null }))).toEqual({
        kind: "blocked",
        reason: "noProvider",
      });
    });
  });
});
