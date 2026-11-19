import { describe, expect, it, vi } from "vitest";
import { createRegionReporter } from "./regionReporter";

const regions = [{ x: 1, y: 2, width: 3, height: 4 }];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createRegionReporter", () => {
  it("sends a set once while it does not change", () => {
    const send = vi.fn(() => Promise.resolve());
    const reporter = createRegionReporter(send);
    reporter.report(regions);
    reporter.report([...regions]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends the same set again after a send failed, so native code is never left without it", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("not ready")).mockResolvedValue(undefined);
    const reporter = createRegionReporter(send);
    reporter.report(regions);
    await settle();
    reporter.report(regions);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale failure erase a newer set", async () => {
    let fail: (error: Error) => void = () => {};
    const send = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
      .mockResolvedValue(undefined);
    const reporter = createRegionReporter(send);
    const next = [{ x: 9, y: 9, width: 9, height: 9 }];
    reporter.report(regions);
    reporter.report(next);
    fail(new Error("late"));
    await settle();
    reporter.report(next);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends the last set again once told to forget it", () => {
    const send = vi.fn(() => Promise.resolve());
    const reporter = createRegionReporter(send);
    reporter.report(regions);
    reporter.forget();
    reporter.report(regions);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
