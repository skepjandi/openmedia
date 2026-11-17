import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";
import { DARK_MODE_DEFAULT } from "../shared/darkMode";
import type { AppState } from "../shared/ipc";

const appState = {
  darkMode: DARK_MODE_DEFAULT,
  darkSites: { "youtube.com": { mode: "off" } },
} as unknown as AppState;

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  useApp.setState({ state: appState, error: null });
});

describe("dark mode", () => {
  it("merges the changes and saves the whole setting", async () => {
    await useApp.getState().setDarkMode({ enabled: true, brightness: 90 });
    const expected = { ...DARK_MODE_DEFAULT, enabled: true, brightness: 90 };
    expect(useApp.getState().state?.darkMode).toEqual(expected);
    expect(invoke).toHaveBeenCalledWith("set_dark_mode", { darkMode: expected });
  });

  it("puts the old setting back when saving fails", async () => {
    invoke.mockRejectedValue(new Error("no"));
    await useApp.getState().setDarkMode({ enabled: true });
    expect(useApp.getState().state?.darkMode).toEqual(DARK_MODE_DEFAULT);
    expect(useApp.getState().error).not.toBeNull();
  });

  it("saves a site's own choice and drops an empty one", async () => {
    await useApp.getState().setSiteDarkMode("reddit.com", { mode: "on", method: "static" });
    expect(invoke).toHaveBeenCalledWith("set_site_dark_mode", {
      site: "reddit.com",
      dark: { mode: "on", method: "static" },
    });
    expect(useApp.getState().state?.darkSites["reddit.com"]).toEqual({
      mode: "on",
      method: "static",
    });

    await useApp.getState().setSiteDarkMode("youtube.com", {});
    expect(Object.keys(useApp.getState().state?.darkSites ?? {})).toEqual(["reddit.com"]);
  });

  it("restores the sites when saving a site's choice fails", async () => {
    invoke.mockRejectedValue(new Error("no"));
    await useApp.getState().setSiteDarkMode("youtube.com", {});
    expect(useApp.getState().state?.darkSites).toEqual({ "youtube.com": { mode: "off" } });
  });
});
