import { describe, expect, it } from "vitest";
import { quickAccessLimit, toggleSelection } from "./selection";

describe("quickAccessLimit", () => {
  it("is three for free and five for Pro", () => {
    expect(quickAccessLimit(false)).toBe(3);
    expect(quickAccessLimit(true)).toBe(5);
  });
});

describe("toggleSelection", () => {
  it("adds in order and removes on a second tap", () => {
    const added = toggleSelection(toggleSelection([], "a", 4), "b", 4);
    expect(added).toEqual(["a", "b"]);
    expect(toggleSelection(added, "a", 4)).toEqual(["b"]);
  });

  it("ignores a tick past the limit but still allows unticking", () => {
    const full = ["a", "b", "c", "d"];
    expect(toggleSelection(full, "e", 4)).toEqual(full);
    expect(toggleSelection(full, "d", 4)).toEqual(["a", "b", "c"]);
  });
});
