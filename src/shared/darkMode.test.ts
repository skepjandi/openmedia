import { describe, expect, it } from "vitest";
import {
  DARK_MODE_DEFAULT,
  DARK_PRESETS,
  activePreset,
  clamp,
  darkSiteLabel,
  isClockTime,
  strokeLabel,
} from "./darkMode";

describe("dark mode presets", () => {
  it("finds the preset whose colours are in use, ignoring case", () => {
    expect(activePreset(DARK_MODE_DEFAULT)?.id).toBe("default");
    expect(activePreset({ background: "#0D1117", text: "#C9D1D9" })?.id).toBe("midnight");
  });

  it("finds none for custom colours", () => {
    expect(activePreset({ background: "#123456", text: "#e8e6e3" })).toBeUndefined();
  });

  it("has unique ids and lowercase #rrggbb colours", () => {
    expect(new Set(DARK_PRESETS.map((preset) => preset.id)).size).toBe(DARK_PRESETS.length);
    for (const preset of DARK_PRESETS) {
      expect(preset.background).toMatch(/^#[0-9a-f]{6}$/);
      expect(preset.text).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("clamp", () => {
  it("rounds and holds the value in range", () => {
    expect(clamp(120.4, 50, 150)).toBe(120);
    expect(clamp(10, 50, 150)).toBe(50);
    expect(clamp(999, 50, 150)).toBe(150);
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
  });
});

describe("strokeLabel", () => {
  it("shows tenths of a pixel", () => {
    expect(strokeLabel(0)).toBe("0");
    expect(strokeLabel(3)).toBe("0.3");
    expect(strokeLabel(10)).toBe("1");
  });
});

describe("isClockTime", () => {
  it("accepts HH:MM only", () => {
    expect(isClockTime("21:00")).toBe(true);
    expect(isClockTime("00:00")).toBe(true);
    expect(isClockTime("24:00")).toBe(false);
    expect(isClockTime("7:00")).toBe(false);
    expect(isClockTime("")).toBe(false);
  });
});

describe("darkSiteLabel", () => {
  it("names the mode, then the method", () => {
    expect(darkSiteLabel({ mode: "on", method: "static" })).toEqual([
      "favorites.darkOn",
      "settings.darkMethodStatic",
    ]);
    expect(darkSiteLabel({ mode: "off" })).toEqual(["favorites.darkOff"]);
    expect(darkSiteLabel({ method: "filter" })).toEqual(["settings.darkMethodFilter"]);
    expect(darkSiteLabel({})).toEqual([]);
  });
});
