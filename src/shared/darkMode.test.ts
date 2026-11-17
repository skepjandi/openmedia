import { describe, expect, it } from "vitest";
import {
  DARK_MODE_DEFAULT,
  DARK_PRESETS,
  activePreset,
  clamp,
  darkActiveFor,
  effectiveDark,
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

describe("effectiveDark", () => {
  it("is general for a site with no entry", () => {
    expect(effectiveDark(DARK_MODE_DEFAULT, undefined)).toEqual(DARK_MODE_DEFAULT);
    expect(effectiveDark(DARK_MODE_DEFAULT, {})).toEqual(DARK_MODE_DEFAULT);
  });

  it("lays the site's own fields over general and leaves the rest", () => {
    const schedule = { kind: "time" as const, from: "20:00", to: "06:00" };
    const result = effectiveDark(DARK_MODE_DEFAULT, {
      method: "static",
      brightness: 120,
      background: "#000000",
      schedule,
      images: false,
    });
    expect(result).toEqual({
      ...DARK_MODE_DEFAULT,
      method: "static",
      brightness: 120,
      background: "#000000",
      schedule,
      images: false,
    });
  });

  it("takes the site's mode for the switch, else general's", () => {
    const general = { ...DARK_MODE_DEFAULT, enabled: true };
    expect(effectiveDark(general, { mode: "off" }).enabled).toBe(false);
    expect(effectiveDark(DARK_MODE_DEFAULT, { mode: "on" }).enabled).toBe(true);
    expect(effectiveDark(general, { method: "filter" }).enabled).toBe(true);
  });

  it("ignores a field that was handed back to general", () => {
    expect(effectiveDark(DARK_MODE_DEFAULT, { sepia: undefined, mode: undefined })).toEqual(
      DARK_MODE_DEFAULT,
    );
  });
});

describe("darkActiveFor", () => {
  const off = { enabled: false };
  const on = { enabled: true };

  it("follows the global switch for a site with no mode of its own", () => {
    expect(darkActiveFor(on, {}, "a.com")).toBe(true);
    expect(darkActiveFor(off, {}, "a.com")).toBe(false);
    expect(darkActiveFor(on, { "a.com": { method: "filter" } }, "a.com")).toBe(true);
  });

  it("lets the site's own mode win over the global switch", () => {
    expect(darkActiveFor(off, { "a.com": { mode: "on" } }, "a.com")).toBe(true);
    expect(darkActiveFor(on, { "a.com": { mode: "off" } }, "a.com")).toBe(false);
    expect(darkActiveFor(on, { "b.com": { mode: "off" } }, "a.com")).toBe(true);
  });

  it("uses only the global switch when no page is open", () => {
    expect(darkActiveFor(on, { "a.com": { mode: "off" } }, null)).toBe(true);
    expect(darkActiveFor(off, {}, null)).toBe(false);
  });
});
