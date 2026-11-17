import { describe, expect, it } from "vitest";
import { AWAY_MS, needsPause, pauseDelayFor, pauseDone } from "./pause";
import { NO_LIMITS } from "./policy";

describe("when the pause screen shows", () => {
  it("shows for a session that was never in front", () => {
    expect(needsPause(null, 1_000)).toBe(true);
  });

  it("does not show again for a brief look elsewhere", () => {
    expect(needsPause(10_000, 10_000 + AWAY_MS - 1)).toBe(false);
  });

  it("shows again after being away long enough", () => {
    expect(needsPause(10_000, 10_000 + AWAY_MS)).toBe(true);
  });
});

describe("which delay applies", () => {
  const limits = { ...NO_LIMITS, pauses: { "example.com": 10, "m.example.com": 30 } };

  it("uses the longest delay among the domains around the host", () => {
    expect(pauseDelayFor(limits, "example.com")).toBe(30);
    expect(pauseDelayFor(limits, "www.example.com")).toBe(10);
    expect(pauseDelayFor(limits, "other.test")).toBeNull();
    expect(pauseDelayFor(limits, "notexample.com")).toBeNull();
  });

  it("shows none when pause screens are off for every site", () => {
    expect(pauseDelayFor({ ...limits, pauseEnabled: false }, "example.com")).toBeNull();
  });

  it("enables Continue exactly when the delay has passed", () => {
    expect(pauseDone(10, 9.9)).toBe(false);
    expect(pauseDone(10, 10)).toBe(true);
  });
});
