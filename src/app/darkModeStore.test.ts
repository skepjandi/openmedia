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
  videoSites: { "tiktok.com": { panel: false } },
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

describe("a site's richer dark choice", () => {
  it("keeps a site that sets only a look field, and drops it once every field is handed back", async () => {
    await useApp.getState().setSiteDarkMode("reddit.com", { brightness: 120, images: false });
    expect(useApp.getState().state?.darkSites["reddit.com"]).toEqual({
      brightness: 120,
      images: false,
    });
    expect(invoke).toHaveBeenCalledWith("set_site_dark_mode", {
      site: "reddit.com",
      dark: { brightness: 120, images: false },
    });

    await useApp
      .getState()
      .setSiteDarkMode("reddit.com", { brightness: undefined, images: undefined });
    expect(useApp.getState().state?.darkSites["reddit.com"]).toBeUndefined();
  });

  it("restores the previous entries when saving a schedule fails", async () => {
    invoke.mockRejectedValue(new Error("no"));
    const schedule = { kind: "time" as const, from: "20:00", to: "06:00" };
    await useApp.getState().setSiteDarkMode("reddit.com", { schedule });
    expect(useApp.getState().state?.darkSites).toEqual({ "youtube.com": { mode: "off" } });
    expect(useApp.getState().error).not.toBeNull();
  });
});

describe("a site's video controls", () => {
  it("saves the new fields and drops an entry that sets none", async () => {
    await useApp
      .getState()
      .setSiteVideoControls("tiktok.com", { remember: true, loopOff: true, autoAdvance: false });
    expect(invoke).toHaveBeenCalledWith("set_site_video_controls", {
      site: "tiktok.com",
      video: { remember: true, loopOff: true, autoAdvance: false },
    });
    expect(useApp.getState().state?.videoSites["tiktok.com"]).toEqual({
      remember: true,
      loopOff: true,
      autoAdvance: false,
    });

    await useApp.getState().setSiteVideoControls("tiktok.com", { remember: undefined });
    expect(useApp.getState().state?.videoSites).toEqual({});
  });

  it("restores the previous entries when saving fails", async () => {
    invoke.mockRejectedValue(new Error("no"));
    await useApp.getState().setSiteVideoControls("tiktok.com", { autoAdvance: true });
    expect(useApp.getState().state?.videoSites).toEqual({ "tiktok.com": { panel: false } });
  });
});
