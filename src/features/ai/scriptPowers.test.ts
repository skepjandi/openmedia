import { describe, expect, it } from "vitest";
import type { Power } from "./ipc";
import { groupPowers, limitLines } from "./scriptPowers";

const power = (code: string, line: number): Power => ({ code, message: "", line });

describe("groupPowers", () => {
  it("shows each topic once, in order of first appearance", () => {
    const groups = groupPowers([power("storage", 4), power("network", 2), power("storage", 1)]);
    expect(groups).toEqual([
      { topic: "storage", lines: [1, 4] },
      { topic: "network", lines: [2] },
    ]);
  });

  it("maps dynamic-code and folds unknown codes into other", () => {
    const groups = groupPowers([
      power("dynamic-code", 3),
      power("regex", 9),
      power("global-not-allowed", 7),
      power("regex", 9),
    ]);
    expect(groups).toEqual([
      { topic: "dynamicCode", lines: [3] },
      { topic: "other", lines: [7, 9] },
    ]);
  });

  it("is empty without findings", () => {
    expect(groupPowers([])).toEqual([]);
  });
});

describe("limitLines", () => {
  it("keeps up to five and flags the rest", () => {
    expect(limitLines([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3, 4, 5], more: false });
    expect(limitLines([1, 2, 3, 4, 5, 6])).toEqual({ shown: [1, 2, 3, 4, 5], more: true });
  });
});
