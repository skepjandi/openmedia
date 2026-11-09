import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { selectSettingsOpen, useApp } from "./store";
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
