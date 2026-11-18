import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ state: { desktopSites: ["reddit.com"] } as never, error: null });
});

describe("desktop site", () => {
  it("adds and removes a site, asking Rust to save each change", async () => {
    invoke.mockResolvedValue(undefined);
    await useApp.getState().setSiteDesktop("example.com", true);
    expect(useApp.getState().state?.desktopSites).toEqual(["reddit.com", "example.com"]);
    expect(invoke).toHaveBeenCalledWith("set_site_desktop", {
      site: "example.com",
      enabled: true,
    });
    await useApp.getState().setSiteDesktop("reddit.com", false);
    expect(useApp.getState().state?.desktopSites).toEqual(["example.com"]);
  });

  it("puts the list back and reports when Rust refuses", async () => {
    invoke.mockRejectedValue("no such site to favorite");
    await useApp.getState().setSiteDesktop("example.com", true);
    expect(useApp.getState().state?.desktopSites).toEqual(["reddit.com"]);
    expect(useApp.getState().error).not.toBeNull();
  });
});
