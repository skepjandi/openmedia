import { describe, expect, it } from "vitest";
import {
  DIAL_RADIUS,
  RING_HALF_SPAN,
  TOOL_STEP,
  FAB_SIZE,
  FAVORITE_SIZE,
  HOLD_SCALE,
  SETTINGS_SIZE,
  clampRotation,
  dialMaxRotation,
  dialSlots,
  dialTargetAt,
  dialTurn,
  dialWindow,
  fabCenter,
  HIDE_REACH,
  PEEK_HEIGHT,
  peekCenterY,
  pushedOffEdge,
  separateVerticalPosition,
  snapRotation,
  snapToEdge,
  snapToolScroll,
  toolMaxScroll,
  toolPlan,
  toolSlots,
  type ToolItem,
  type DialItem,
  type Insets,
} from "./geometry";

const phone = { width: 393, height: 852 };
const insets: Insets = { top: 59, bottom: 34 };

describe("snapToEdge", () => {
  it("picks the nearer edge", () => {
    expect(snapToEdge({ x: 100, y: 400 }, phone, insets).edge).toBe("left");
    expect(snapToEdge({ x: 300, y: 400 }, phone, insets).edge).toBe("right");
  });

  it("keeps the button inside the safe area", () => {
    const top = snapToEdge({ x: 10, y: -500 }, phone, insets);
    const bottom = snapToEdge({ x: 10, y: 5000 }, phone, insets);
    expect(fabCenter("left", top.y, phone, insets).y - FAB_SIZE / 2).toBeGreaterThanOrEqual(
      insets.top,
    );
    expect(fabCenter("left", bottom.y, phone, insets).y + FAB_SIZE / 2).toBeLessThanOrEqual(
      phone.height - insets.bottom,
    );
  });
});

describe("separateVerticalPosition", () => {
  it("moves to the nearest safe position without crossing the viewport bounds", () => {
    expect(separateVerticalPosition(150, 150, 50, 250, 74)).toBe(76);
    expect(separateVerticalPosition(80, 100, 50, 250, 74)).toBe(174);
    expect(separateVerticalPosition(240, 230, 50, 250, 74)).toBe(156);
  });

  it("leaves positions outside the clearance unchanged", () => {
    expect(separateVerticalPosition(100, 180, 50, 250, 74)).toBe(100);
  });
});

const tool = (kind: "settings" | "history" | "tabs"): DialItem => ({
  target: { kind },
  size: SETTINGS_SIZE,
  section: 0,
});
const favorite = (index: number, section: number): DialItem => ({
  target: { kind: "favorite", index },
  size: FAVORITE_SIZE,
  section,
});
const items: DialItem[] = [
  tool("settings"),
  tool("history"),
  tool("tabs"),
  favorite(0, 1),
  favorite(1, 1),
  favorite(2, 2),
  favorite(3, 2),
  favorite(4, 2),
  favorite(5, 2),
];

describe("dialWindow", () => {
  it("is the whole ring in the middle of the screen", () => {
    const origin = fabCenter("left", 426, phone, insets);
    expect(dialWindow(origin, "left", phone, insets)).toEqual({
      lo: -RING_HALF_SPAN,
      hi: RING_HALF_SPAN,
    });
    const right = fabCenter("right", 426, phone, insets);
    expect(dialWindow(right, "right", phone, insets)).toEqual({
      lo: -RING_HALF_SPAN,
      hi: RING_HALF_SPAN,
    });
  });

  it("loses the part that would leave the screen near the top", () => {
    const origin = fabCenter("left", 0, phone, insets);
    const { lo, hi } = dialWindow(origin, "left", phone, insets);
    expect(lo).toBeGreaterThan(-90);
    expect(hi).toBe(RING_HALF_SPAN);
  });
});

describe("dialSlots", () => {
  const origin = fabCenter("left", 426, phone, insets);

  it("lists the items top to bottom on both edges, the first at the top", () => {
    for (const edge of ["left", "right"] as const) {
      const at = fabCenter(edge, 426, phone, insets);
      const slots = dialSlots(at, edge, phone, insets, items, 0);
      const ys = slots.map((slot) => slot.center.y);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
      expect(slots[0].center.y).toBeLessThan(at.y);
    }
  });

  it("opens away from the edge the button rests on", () => {
    const left = dialSlots(origin, "left", phone, insets, items, 0);
    expect(left.every((slot) => slot.center.x >= origin.x - 1e-6)).toBe(true);
    const right = fabCenter("right", 426, phone, insets);
    const mirrored = dialSlots(right, "right", phone, insets, items, 0);
    expect(mirrored.every((slot) => slot.center.x <= right.x + 1e-6)).toBe(true);
  });

  it("keeps every item the same distance from the button and clear of its neighbours", () => {
    const slots = dialSlots(origin, "left", phone, insets, items, 0);
    for (const slot of slots) {
      expect(Math.hypot(slot.center.x - origin.x, slot.center.y - origin.y)).toBeCloseTo(
        DIAL_RADIUS,
      );
    }
    const visible = slots.filter((slot) => slot.opacity === 1);
    visible.slice(1).forEach((slot, i) => {
      const gap = Math.hypot(
        slot.center.x - visible[i].center.x,
        slot.center.y - visible[i].center.y,
      );
      expect(gap).toBeGreaterThanOrEqual((slot.size + visible[i].size) / 2);
    });
  });

  it("shows only the items on the visible arc and fades the rest out", () => {
    const slots = dialSlots(origin, "left", phone, insets, items, 0);
    expect(slots.slice(0, 4).every((slot) => slot.opacity === 1)).toBe(true);
    expect(slots[items.length - 1].opacity).toBe(0);
  });

  it("brings later items into view as the dial turns", () => {
    const window = dialWindow(origin, "left", phone, insets);
    const turned = dialMaxRotation(items, window);
    const slots = dialSlots(origin, "left", phone, insets, items, turned);
    expect(slots[items.length - 1].opacity).toBe(1);
    expect(slots[0].opacity).toBe(0);
  });

  it("keeps every visible item on screen near the top and bottom edges", () => {
    for (const edge of ["left", "right"] as const) {
      for (const y of [0, 100, 426, 750, 5000]) {
        const at = fabCenter(edge, y, phone, insets);
        for (const rotation of [0, 1, 2.5]) {
          for (const slot of dialSlots(at, edge, phone, insets, items, rotation)) {
            if (slot.opacity < 1) continue;
            const half = slot.size / 2;
            expect(slot.center.x - half).toBeGreaterThanOrEqual(0);
            expect(slot.center.x + half).toBeLessThanOrEqual(phone.width);
            expect(slot.center.y - half).toBeGreaterThanOrEqual(insets.top);
            expect(slot.center.y + half).toBeLessThanOrEqual(phone.height - insets.bottom);
          }
        }
      }
    }
  });
});

describe("dial rotation", () => {
  const origin = fabCenter("left", 426, phone, insets);
  const window = dialWindow(origin, "left", phone, insets);

  it("never turns before the first item or past the last", () => {
    const max = dialMaxRotation(items, window);
    expect(max).toBeGreaterThan(0);
    expect(clampRotation(-3, items, window)).toBe(0);
    expect(clampRotation(max + 4, items, window)).toBe(max);
  });

  it("does not turn when every item already fits", () => {
    expect(dialMaxRotation(items.slice(0, 3), window)).toBe(0);
    expect(dialMaxRotation([], window)).toBe(0);
  });

  it("settles with an item on the first stop", () => {
    const settled = snapRotation(2.2, items, window);
    const slots = dialSlots(origin, "left", phone, insets, items, settled);
    const first = slots.find((slot) => slot.opacity === 1) ?? slots[0];
    const radians = (window.lo * Math.PI) / 180;
    const top = {
      x: origin.x + DIAL_RADIUS * Math.cos(radians),
      y: origin.y + DIAL_RADIUS * Math.sin(radians),
    };
    expect(Math.hypot(first.center.x - top.x, first.center.y - top.y)).toBeLessThan(1e-6);
  });

  it("follows a finger: dragging down the arc moves the items down it on either edge", () => {
    for (const edge of ["left", "right"] as const) {
      const at = fabCenter(edge, 426, phone, insets);
      const side = edge === "left" ? 1 : -1;
      const from = { x: at.x + side * DIAL_RADIUS, y: at.y };
      const to = { x: at.x + side * DIAL_RADIUS * 0.87, y: at.y + DIAL_RADIUS * 0.5 };
      const turn = dialTurn(at, edge, from, to);
      // moving down the dial means going back to earlier items
      expect(turn).toBeCloseTo(-1, 1);
      expect(dialTurn(at, edge, to, from)).toBeCloseTo(1, 1);
    }
  });
});

const toolItems: ToolItem[] = [
  { target: { kind: "stats" }, size: 44 },
  { target: { kind: "tabs" }, size: 44 },
  { target: { kind: "history" }, size: 44 },
  { target: { kind: "settings" }, size: 44 },
];

describe("tool columns", () => {
  const origin = fabCenter("left", 426, phone, insets);

  it("put the page column where there is more room and the switches across the button", () => {
    const high = toolPlan(fabCenter("left", 100, phone, insets), phone, insets);
    expect([high.pageSide, high.switchSide]).toEqual([1, -1]);
    const low = toolPlan(fabCenter("left", 800, phone, insets), phone, insets);
    expect([low.pageSide, low.switchSide]).toEqual([-1, 1]);
  });

  it("run straight down or up from the button, one step apart, the first at the start", () => {
    const plan = toolPlan(origin, phone, insets);
    const slots = toolSlots(origin, phone, insets, toolItems, plan.pageSide, plan.pageStart, 0);
    slots.forEach((slot, k) => {
      expect(slot.center.x).toBe(origin.x);
      expect(slot.center.y).toBeCloseTo(
        origin.y + plan.pageSide * (plan.pageStart + k * TOOL_STEP),
      );
      expect(slot.opacity).toBe(1);
    });
  });

  it("stay clear of the open button and of the ring", () => {
    const plan = toolPlan(origin, phone, insets);
    const column = toolSlots(
      origin,
      phone,
      insets,
      toolItems,
      plan.switchSide,
      plan.switchStart,
      0,
    );
    const ring = dialSlots(origin, "left", phone, insets, items, 0).filter(
      (slot) => slot.opacity === 1,
    );
    for (const a of column) {
      for (const b of ring) {
        const gap = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
        expect(gap).toBeGreaterThanOrEqual((a.size + b.size) / 2);
      }
    }
  });

  it("slide along the line and fade out past the end of the screen", () => {
    const high = origin;
    const plan = toolPlan(high, phone, insets);
    const max = toolMaxScroll(high, phone, insets, plan.pageSide, plan.pageStart, 8);
    expect(max).toBeGreaterThan(0);
    const many: ToolItem[] = Array.from({ length: 8 }, () => toolItems[0]);
    const start = toolSlots(high, phone, insets, many, plan.pageSide, plan.pageStart, 0);
    expect(start[7].opacity).toBe(0);
    const end = toolSlots(high, phone, insets, many, plan.pageSide, plan.pageStart, max);
    expect(end[7].opacity).toBe(1);
    expect(end[0].opacity).toBe(0);
  });

  it("need no sliding when they fit, and settle on a whole button", () => {
    const plan = toolPlan(origin, phone, insets);
    expect(toolMaxScroll(origin, phone, insets, plan.pageSide, plan.pageStart, 4)).toBe(0);
    expect(snapToolScroll(2.4, 5)).toBe(2);
    expect(snapToolScroll(9, 5)).toBe(5);
    expect(snapToolScroll(-1, 5)).toBe(0);
  });
});

describe("dialTargetAt", () => {
  const origin = fabCenter("left", 426, phone, insets);
  const slots = dialSlots(origin, "left", phone, insets, items, 0);

  it("finds the item under the finger", () => {
    expect(dialTargetAt(slots[1].center, slots)).toEqual({ kind: "history" });
    const slack = { x: slots[3].center.x + FAVORITE_SIZE / 2 + 5, y: slots[3].center.y };
    expect(dialTargetAt(slack, slots)).toEqual({ kind: "favorite", index: 0 });
  });

  it("cannot find an item that has turned out of view", () => {
    expect(dialTargetAt(slots[items.length - 1].center, slots)).not.toEqual(
      items[items.length - 1].target,
    );
  });

  it("returns null away from every item", () => {
    expect(dialTargetAt({ x: 380, y: 10 }, slots)).toBeNull();
  });
});

describe("pushedOffEdge", () => {
  it("hides the button only when it is dropped at a screen edge", () => {
    expect(pushedOffEdge({ x: HIDE_REACH, y: 300 }, phone)).toBe("left");
    expect(pushedOffEdge({ x: -20, y: 300 }, phone)).toBe("left");
    expect(pushedOffEdge({ x: phone.width - HIDE_REACH, y: 300 }, phone)).toBe("right");
    expect(pushedOffEdge({ x: HIDE_REACH + 1, y: 300 }, phone)).toBeNull();
    expect(pushedOffEdge(fabCenter("right", 300, phone, insets), phone)).toBeNull();
  });
});

describe("peekCenterY", () => {
  it("keeps the tab clear of the status bar and the home indicator", () => {
    expect(peekCenterY(0, phone, insets)).toBeGreaterThanOrEqual(insets.top + PEEK_HEIGHT / 2);
    expect(peekCenterY(phone.height, phone, insets)).toBeLessThanOrEqual(
      phone.height - insets.bottom - PEEK_HEIGHT / 2,
    );
    expect(peekCenterY(400, phone, insets)).toBe(400);
  });

  it("rests far enough from every edge that the enlarged button, ring included, stays on screen", () => {
    const reach = (FAB_SIZE / 2) * HOLD_SCALE + 2;
    for (const edge of ["left", "right"] as const) {
      for (const y of [0, 400, 5000]) {
        const rest = fabCenter(edge, y, phone, insets);
        expect(rest.x - reach).toBeGreaterThanOrEqual(0);
        expect(rest.x + reach).toBeLessThanOrEqual(phone.width);
        expect(rest.y - reach).toBeGreaterThanOrEqual(insets.top);
        expect(rest.y + reach).toBeLessThanOrEqual(phone.height - insets.bottom);
      }
    }
  });
});
