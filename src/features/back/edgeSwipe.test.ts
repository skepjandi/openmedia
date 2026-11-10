import { describe, expect, it } from "vitest";
import {
  EDGE_ZONE,
  LOCK_DISTANCE,
  SWIPE_DISTANCE,
  backSide,
  commitsBack,
  inwardTravel,
  isBackDrag,
  startsAtEdge,
  type Side,
} from "./edgeSwipe";

const width = 400;

describe("edge swipe back", () => {
  it("starts only inside the edge zone of the reading side", () => {
    expect(startsAtEdge(EDGE_ZONE, width, "left")).toBe(true);
    expect(startsAtEdge(EDGE_ZONE + 1, width, "left")).toBe(false);
    expect(startsAtEdge(width - EDGE_ZONE, width, "right")).toBe(true);
    expect(startsAtEdge(width - EDGE_ZONE - 1, width, "right")).toBe(false);
    expect(startsAtEdge(width - 1, width, "left")).toBe(false);
  });

  it("uses the right edge for right-to-left languages", () => {
    expect(backSide("ltr")).toBe("left");
    expect(backSide("rtl")).toBe("right");
  });

  it.each<[Side, number]>([
    ["left", 1],
    ["right", -1],
  ])("follows the finger inward from the %s edge", (side, direction) => {
    const start = { x: side === "left" ? 10 : width - 10, y: 300 };

    expect(inwardTravel(start, { x: start.x + direction * 50, y: 300 }, side)).toBe(50);
    expect(inwardTravel(start, { x: start.x - direction * 5, y: 300 }, side)).toBe(-5);
    expect(isBackDrag(start, { x: start.x + direction * (LOCK_DISTANCE - 1), y: 300 }, side)).toBe(
      false,
    );
    expect(isBackDrag(start, { x: start.x + direction * LOCK_DISTANCE, y: 300 }, side)).toBe(true);
  });

  it("does not take a mostly vertical drag or travel toward the edge for the gesture", () => {
    const start = { x: 10, y: 300 };

    expect(isBackDrag(start, { x: -200, y: 300 }, "left")).toBe(false);
    expect(isBackDrag(start, { x: 10 + 40, y: 300 + 40 }, "left")).toBe(false);
  });

  it("closes past 40% of the width, or on a flick, never from a short drag", () => {
    expect(commitsBack(width * 0.4, 0, width)).toBe(true);
    expect(commitsBack(width * 0.4 - 1, 0, width)).toBe(false);
    expect(commitsBack(SWIPE_DISTANCE, 0.6, width)).toBe(true);
    expect(commitsBack(SWIPE_DISTANCE - 1, 2, width)).toBe(false);
  });
});
