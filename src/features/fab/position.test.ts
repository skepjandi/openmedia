import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPosition } from "./position";

function stubStorage(value: unknown) {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(value) });
}

describe("loadPosition", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads a hidden button", () => {
    stubStorage({ edge: "left", yRatio: 0.3, hidden: true });
    expect(loadPosition()).toEqual({ edge: "left", yRatio: 0.3, hidden: true });
  });

  it("shows a button saved before hiding existed", () => {
    stubStorage({ edge: "right", yRatio: 0.5 });
    expect(loadPosition()).toEqual({ edge: "right", yRatio: 0.5, hidden: false });
  });
});
