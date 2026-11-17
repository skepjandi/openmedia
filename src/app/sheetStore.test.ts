import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { selectPage, selectSettingsOpen, useApp } from "./store";
import { newSession } from "../features/web/sessions";
import { useEntitlementStore } from "../features/paywall/store";

beforeEach(() => {
  useApp.setState({ sheet: "none", sheetParent: "none", sheetBack: [], sheetSite: null });
  useEntitlementStore.setState({ status: "free", configured: true, snapshot: null });
});

describe("pages opened from Settings", () => {
  it("returns to Settings when the paywall closes, and keeps Settings mounted beneath it", () => {
    useApp.getState().openSheet("settings");
    useApp.getState().openSheet("paywall");
    expect(useApp.getState().sheet).toBe("paywall");
    expect(selectSettingsOpen(useApp.getState())).toBe(true);
    useApp.getState().closeSheet();
    expect(useApp.getState().sheet).toBe("settings");
    useApp.getState().closeSheet();
    expect(useApp.getState().sheet).toBe("none");
    expect(selectSettingsOpen(useApp.getState())).toBe(false);
  });

  it("returns to Settings from the Recipes page", () => {
    useApp.getState().openSheet("settings");
    useApp.getState().openSheet("recipes");
    expect(useApp.getState().sheet).toBe("recipes");
    useApp.getState().closeSheet();
    expect(useApp.getState().sheet).toBe("settings");
  });
  it("returns to Settings from the Incognito Recipes page", () => {
    useApp.getState().openSheet("settings");
    useApp.getState().openSheet("incognito-recipes");
    expect(useApp.getState().sheet).toBe("incognito-recipes");
    expect(selectSettingsOpen(useApp.getState())).toBe(true);
    useApp.getState().closeSheet();
    expect(useApp.getState().sheet).toBe("settings");
  });

  it.each(["library", "share-recipe", "more-favorites", "incognito-more-favorites"] as const)(
    "returns to Settings from the %s page, keeping Settings mounted beneath it",
    (page) => {
      useApp.getState().openSheet("settings");
      useApp.getState().openSheet(page);
      expect(useApp.getState().sheet).toBe(page);
      expect(selectSettingsOpen(useApp.getState())).toBe(true);
      useApp.getState().closeSheet();
      expect(useApp.getState().sheet).toBe("settings");
    },
  );

  it("closes to the page when the paywall was not opened from Settings", () => {
    useApp.getState().openSheet("settings");
    useApp.getState().closeSheet();
    useApp.getState().openSheet("paywall");
    expect(selectSettingsOpen(useApp.getState())).toBe(false);
    useApp.getState().closeSheet();
    expect(useApp.getState().sheet).toBe("none");
  });

  it("a paywall raised by a Pro-only action inside Settings also returns to Settings", async () => {
    useApp.getState().openSheet("settings");
    await useApp.getState().enterIncognito();
    expect(useApp.getState().sheet).toBe("paywall");
    useApp.getState().closeSheet();
    expect(useApp.getState().sheet).toBe("settings");
  });
});

describe("pages about one site", () => {
  const store = () => useApp.getState();

  it("goes hub, then dark mode, and back to the hub, then to Settings", () => {
    store().openSheet("settings");
    store().openSiteSheet("site-settings", "example.com");
    expect(store().sheetSite).toBe("example.com");
    expect(selectSettingsOpen(store())).toBe(true);
    store().openSiteSheet("site-dark-mode", "example.com");
    expect(store().sheet).toBe("site-dark-mode");
    expect(selectSettingsOpen(store())).toBe(true);
    store().closeSheet();
    expect(store().sheet).toBe("site-settings");
    expect(store().sheetSite).toBe("example.com");
    expect(selectSettingsOpen(store())).toBe(true);
    store().closeSheet();
    expect(store().sheet).toBe("settings");
    expect(store().sheetSite).toBeNull();
    store().closeSheet();
    expect(store().sheet).toBe("none");
  });

  it("goes from the hub to the video page and back", () => {
    store().openSheet("settings");
    store().openSiteSheet("site-settings", "example.com");
    store().openSiteSheet("site-video", "example.com");
    expect(store().sheet).toBe("site-video");
    store().closeSheet();
    expect(store().sheet).toBe("site-settings");
  });

  it("closes to the page when opened from the floating button", () => {
    store().openSiteSheet("site-dark-mode", "example.com");
    expect(store().sheet).toBe("site-dark-mode");
    expect(selectSettingsOpen(store())).toBe(false);
    expect(store().sheetBack).toEqual([]);
    store().closeSheet();
    expect(store().sheet).toBe("none");
    expect(store().sheetSite).toBeNull();
  });

  it("returns from the shared dark mode page to the site's page, whatever sits beneath", () => {
    store().openSiteSheet("site-dark-mode", "example.com");
    store().openSheet("dark-mode");
    expect(store().sheet).toBe("dark-mode");
    store().closeSheet();
    expect(store().sheet).toBe("site-dark-mode");
    expect(store().sheetSite).toBe("example.com");
    store().closeSheet();
    expect(store().sheet).toBe("none");

    store().openSheet("settings");
    store().openSiteSheet("site-settings", "example.com");
    store().openSiteSheet("site-dark-mode", "example.com");
    store().openSheet("dark-mode");
    store().closeSheet();
    expect(store().sheet).toBe("site-dark-mode");
    store().closeSheet();
    expect(store().sheet).toBe("site-settings");
    store().closeSheet();
    expect(store().sheet).toBe("settings");
  });

  it("opens the shared dark mode page from the home screen without a way back to a site", () => {
    store().openSheet("dark-mode");
    expect(store().sheetBack).toEqual([]);
    store().closeSheet();
    expect(store().sheet).toBe("none");
  });
});

describe("closing sites from the Tabs screen", () => {
  const live = (id: string, lastUsed: number) => ({
    ...newSession(id, "typed", `https://${id}.example/`, lastUsed),
    lastUsed,
  });

  it("ends only the live session: favorites and history stay, and the last one can be closed too", () => {
    const favorites = [{ id: "f", name: "A", url: "https://a.example/", icon: null, notify: true }];
    useApp.setState({
      state: { favorites, history: ["https://a.example/"] } as never,
      sessions: [live("a", 10), live("b", 20)],
      activeId: "b",
    });
    useApp.getState().closeSession("b");
    expect(useApp.getState().sessions.map((s) => s.id)).toEqual(["a"]);
    expect(useApp.getState().activeId).toBe("a");
    expect(useApp.getState().state?.favorites).toEqual(favorites);
    expect(useApp.getState().state?.history).toEqual(["https://a.example/"]);
    useApp.getState().closeSession("a");
    expect(useApp.getState().sessions.map((s) => s.id)).toEqual([]);
    expect(useApp.getState().activeId).toBeNull();
    expect(useApp.getState().state?.history).toEqual(["https://a.example/"]);
  });

  it("closes the hidden sessions and leaves the visible one", () => {
    useApp.setState({ sessions: [live("a", 10), live("b", 20), live("c", 5)], activeId: "b" });
    useApp.getState().closeOtherSessions();
    expect(useApp.getState().sessions.map((s) => s.id)).toEqual(["b"]);
    expect(useApp.getState().activeId).toBe("b");
  });
});

describe("a new tab", () => {
  const session = newSession("a", "typed", "https://example.com/", 0);

  beforeEach(() => {
    useApp.setState({ sessions: [session], activeId: "a", blankTab: false, sheet: "tabs" });
  });

  it("is an empty page with the command bar open, and keeps the open sessions", () => {
    useApp.getState().openNewTab();
    const store = useApp.getState();
    expect(store.sheet).toBe("assistant");
    expect(store.blankTab).toBe(true);
    expect(selectPage(store)).toBeNull();
    expect(store.sessions).toHaveLength(1);
  });

  it("gives way to a site the user opens or switches to", () => {
    useApp.getState().openNewTab();
    useApp.getState().openSession("a");
    expect(useApp.getState().blankTab).toBe(false);
    expect(selectPage(useApp.getState())?.id).toBe("a");
    useApp.getState().openNewTab();
    useApp.getState().openSearch("https://www.google.com/search?q=cats");
    expect(useApp.getState().blankTab).toBe(false);
    expect(useApp.getState().sessions).toHaveLength(2);
  });
});
