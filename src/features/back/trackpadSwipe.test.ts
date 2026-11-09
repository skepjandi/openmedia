import { describe, expect, it } from "vitest";
import { SWIPE_DISTANCE, idleSwipe, reduceWheel, type WheelSwipe } from "./trackpadSwipe";

function feed(events: { deltaX: number; deltaY?: number; at: number }[], rtl = false) {
  let state: WheelSwipe = idleSwipe;
  const fired: number[] = [];
  for (const event of events) {
    const step = reduceWheel(state, { deltaY: 0, rtl, ...event });
    state = step.state;
    if (step.back) fired.push(event.at);
  }
  return fired;
}

const swipe = (from: number, count: number, deltaX = -20) =>
  Array.from({ length: count }, (_, i) => ({ deltaX, at: from + i * 16 }));

describe("trackpad back swipe", () => {
  it("fires once when a swipe toward the reading side is long enough", () => {
    expect(feed(swipe(0, 12))).toHaveLength(1);
  });

  it("does not fire for a short swipe", () => {
    expect(feed(swipe(0, Math.floor(SWIPE_DISTANCE / 20) - 2))).toEqual([]);
  });

  it("ignores a swipe the other way and a mostly vertical scroll", () => {
    expect(feed(swipe(0, 20, 20))).toEqual([]);
    expect(feed(swipe(0, 20).map((e) => ({ ...e, deltaY: 40 })))).toEqual([]);
  });

  it("goes back with the opposite swipe on right-to-left pages", () => {
    expect(feed(swipe(0, 12, 20), true)).toHaveLength(1);
    expect(feed(swipe(0, 12, -20), true)).toEqual([]);
  });

  it("does not fire again from the swipe's inertia, but does for the next swipe", () => {
    const inertia = swipe(0, 40);
    const next = swipe(inertia[inertia.length - 1].at + 600, 12);
    expect(feed([...inertia, ...next])).toHaveLength(2);
    expect(feed(inertia)).toHaveLength(1);
  });

  it("starts over after a pause", () => {
    const first = swipe(0, 5);
    const second = swipe(first[first.length - 1].at + 400, 5);
    expect(feed([...first, ...second])).toEqual([]);
  });
});
