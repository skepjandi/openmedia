import { describe, expect, it } from "vitest";
import { overrideCount, withOverrides, withoutFields } from "./overrides";
import { VIDEO_CONTROLS_DEFAULT, effectiveVideo } from "./videoControls";

describe("overrideCount", () => {
  it("counts the fields a site sets itself", () => {
    expect(overrideCount(undefined)).toBe(0);
    expect(overrideCount({})).toBe(0);
    expect(overrideCount({ mode: "on", brightness: 120, images: false })).toBe(3);
  });

  it("does not count a field handed back to general", () => {
    expect(overrideCount({ panel: undefined, height: 40 })).toBe(1);
    expect(overrideCount({ panel: undefined })).toBe(0);
  });
});

describe("withOverrides", () => {
  it("lays defined fields over the base without changing it", () => {
    const base = { a: 1, b: "x", c: true };
    expect(withOverrides(base, { b: "y", c: false })).toEqual({ a: 1, b: "y", c: false });
    expect(base).toEqual({ a: 1, b: "x", c: true });
  });

  it("keeps the base where the site has no value", () => {
    expect(withOverrides({ a: 1, b: 2 }, { a: undefined })).toEqual({ a: 1, b: 2 });
    expect(withOverrides({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("withoutFields", () => {
  it("drops only the named fields", () => {
    const entry: { a?: number; b?: number; c?: number } = { a: 1, b: 2, c: 3 };
    expect(withoutFields(entry, ["a", "c"])).toEqual({ b: 2 });
    expect(entry).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe("effectiveVideo", () => {
  it("is general for a site with no entry", () => {
    expect(effectiveVideo(VIDEO_CONTROLS_DEFAULT, undefined)).toEqual(VIDEO_CONTROLS_DEFAULT);
  });

  it("takes each field the site sets, including an explicit false", () => {
    const general = { ...VIDEO_CONTROLS_DEFAULT, remember: true, autoAdvance: true };
    expect(
      effectiveVideo(general, { panel: false, height: 64, remember: false, fullVideos: true }),
    ).toEqual({
      ...general,
      panel: false,
      height: 64,
      remember: false,
      fullVideos: true,
    });
  });
});
