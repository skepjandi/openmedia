import { describe, expect, it } from "vitest";
import { ACCESSIBILITY_OFF, accessibilityAttributes } from "./accessibility";

describe("accessibilityAttributes", () => {
  it("sets nothing while every choice is off", () => {
    expect(accessibilityAttributes(ACCESSIBILITY_OFF)).toEqual({});
  });

  it("names each choice the stylesheet reacts to", () => {
    expect(
      accessibilityAttributes({
        epilepsyProtection: true,
        font: "opendyslexic",
        spacing: true,
        tint: "cream",
      }),
    ).toEqual({
      "data-calm": "",
      "data-reading-font": "opendyslexic",
      "data-wide-text": "",
    });
  });

  it("leaves the tint to the pages", () => {
    expect(accessibilityAttributes({ ...ACCESSIBILITY_OFF, tint: "blue" })).toEqual({});
  });
});
