import { describe, expect, it } from "vitest";
import { advanceTrail } from "./sessions";

describe("advanceTrail", () => {
  it("pushes the page left behind, pops when returning to it, ignores the first load", () => {
    expect(advanceTrail([], null, "https://a/")).toEqual([]);
    expect(advanceTrail([], "https://a/", "https://b/")).toEqual(["https://a/"]);
    expect(advanceTrail(["https://a/"], "https://b/", "https://a/")).toEqual([]);
    expect(advanceTrail(["https://a/"], "https://b/", "https://b/")).toEqual(["https://a/"]);
  });
});
