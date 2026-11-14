import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ state: { pictureInPictureSites: ["vimeo.com"] } as never, error: null });
});

describe("picture-in-picture", () => {
  it("adds and removes a site, asking Rust to save each change", async () => {
    invoke.mockResolvedValue(undefined);
    await useApp.getState().setSitePictureInPicture("youtube.com", true);
    expect(useApp.getState().state?.pictureInPictureSites).toEqual(["vimeo.com", "youtube.com"]);
    expect(invoke).toHaveBeenCalledWith("set_site_picture_in_picture", {
      site: "youtube.com",
      enabled: true,
    });
    await useApp.getState().setSitePictureInPicture("vimeo.com", false);
    expect(useApp.getState().state?.pictureInPictureSites).toEqual(["youtube.com"]);
  });

  it("puts the list back and reports when Rust refuses", async () => {
    invoke.mockRejectedValue("no such site to favorite");
    await useApp.getState().setSitePictureInPicture("youtube.com", true);
    expect(useApp.getState().state?.pictureInPictureSites).toEqual(["vimeo.com"]);
    expect(useApp.getState().error).not.toBeNull();
  });
});
