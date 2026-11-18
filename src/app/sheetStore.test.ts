import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { selectPage, selectSettingsOpen, useApp } from "./store";
import { newSession } from "../features/web/sessions";
import { useEntitlementStore } from "../features/paywall/store";

beforeEach(() => {
  useApp.setState({ sheet: "none", sheetParent: "none" });
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

  it.each([
    "library",
    "share-recipe",
    "more-favorites",
    "incognito-more-favorites",
    "folders",
    "incognito-folders",
  ] as const)(
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

describe("a favorite's own pages", () => {
  beforeEach(() => {
    useApp.setState({ sheetSite: null, sheetSiteName: null, sheetSiteFavoriteId: null });
    useApp.setState({ focusFavoriteId: null });
  });

  it.each(["site-dark-mode", "site-video"] as const)(
    "%s opens on top of Settings and closes back to it with the favorite to expand",
    (page) => {
      useApp.getState().openSheet("settings");
      useApp.getState().openSiteSheet(page, "reddit.com", "Reddit", "f1");
      const opened = useApp.getState();
      expect(opened.sheet).toBe(page);
      expect(opened.sheetParent).toBe("settings");
      expect([opened.sheetSite, opened.sheetSiteName]).toEqual(["reddit.com", "Reddit"]);
      expect(selectSettingsOpen(opened)).toBe(true);

      useApp.getState().closeSheet();
      const closed = useApp.getState();
      expect(closed.sheet).toBe("settings");
      expect(closed.focusFavoriteId).toBe("f1");
      expect([closed.sheetSite, closed.sheetSiteName, closed.sheetSiteFavoriteId]).toEqual([
        null,
        null,
        null,
      ]);
      useApp.getState().clearFavoriteFocus();
      useApp.getState().closeSheet();
      expect(useApp.getState().sheet).toBe("none");
    },
  );

  it("closes to the page when it was opened with Settings closed", () => {
    useApp.getState().openSiteSheet("site-dark-mode", "reddit.com", "Reddit");
    expect(useApp.getState().sheet).toBe("site-dark-mode");
    expect(useApp.getState().sheetParent).toBe("none");
    expect(selectSettingsOpen(useApp.getState())).toBe(false);
    useApp.getState().closeSheet();
    expect(useApp.getState().sheet).toBe("none");
    expect(useApp.getState().focusFavoriteId).toBeNull();
  });

  it("does not expand a favorite when none was named", () => {
    useApp.getState().openSheet("settings");
    useApp.getState().openSiteSheet("site-video", "reddit.com", "Reddit");
    useApp.getState().closeSheet();
    expect(useApp.getState().sheet).toBe("settings");
    expect(useApp.getState().focusFavoriteId).toBeNull();
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
