import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { selectSettingsOpen, useApp } from "./store";
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

  it.each(["library", "share", "share-recipe"] as const)(
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

describe("closing sites from the Tabs screen", () => {
  const live = (id: string, lastUsed: number) => ({
    ...newSession(id, "typed", `https://${id}.example/`, lastUsed),
    lastUsed,
  });

  it("ends only the live session: favorites and history stay, the last site is kept", () => {
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
    expect(useApp.getState().sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("closes the hidden sessions and leaves the visible one", () => {
    useApp.setState({ sessions: [live("a", 10), live("b", 20), live("c", 5)], activeId: "b" });
    useApp.getState().closeOtherSessions();
    expect(useApp.getState().sessions.map((s) => s.id)).toEqual(["b"]);
    expect(useApp.getState().activeId).toBe("b");
  });
});
