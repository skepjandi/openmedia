import { describe, expect, it } from "vitest";
import { hexToRgb, hexToRgbText } from "./color";

describe("hexToRgb", () => {
  it("reads #rrggbb in either case", () => {
    expect(hexToRgb("#1a2b3c")).toEqual([26, 43, 60]);
    expect(hexToRgb("#FFFFFF")).toEqual([255, 255, 255]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "#12345", "#12345g", "123456", "red", "#1234567"]) {
      expect(hexToRgb(bad)).toBeNull();
    }
  });
});

describe("hexToRgbText", () => {
  it("writes a CSS rgb() string", () => {
    expect(hexToRgbText("#1a2b3c")).toBe("rgb(26, 43, 60)");
    expect(hexToRgbText("nope")).toBeNull();
  });
});
