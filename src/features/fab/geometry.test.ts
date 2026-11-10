import { describe, expect, it } from "vitest";
import {
  FAB_SIZE,
  FAVORITE_SIZE,
  HISTORY_SIZE,
  HOLD_SCALE,
  INCOGNITO_SIZE,
  SETTINGS_SIZE,
  STATS_SIZE,
  fabCenter,
  fanLayout,
  fanTargetAt,
  separateVerticalPosition,
  snapToEdge,
  type Edge,
  type Insets,
  type Point,
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

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe("fanLayout", () => {
  const edges: Edge[] = ["left", "right"];
  const heights = [insets.top, 200, 426, 700, phone.height - insets.bottom];

  for (const edge of edges) {
    for (const y of heights) {
      for (const count of [0, 1, 2, 4, 6]) {
        it(`keeps ${count} favorites on screen and apart (${edge} edge, y=${y})`, () => {
          const origin = fabCenter(edge, y, phone, insets);
          const layout = fanLayout(origin, edge, phone, insets, count);
          const items = [
            ...layout.favorites.map((center) => ({ center, size: FAVORITE_SIZE })),
            { center: layout.settings, size: SETTINGS_SIZE },
            { center: layout.history, size: HISTORY_SIZE },
            { center: layout.stats, size: STATS_SIZE },
            { center: layout.incognito, size: INCOGNITO_SIZE },
          ];
          for (const { center, size } of items) {
            expect(center.x - size / 2).toBeGreaterThanOrEqual(0);
            expect(center.x + size / 2).toBeLessThanOrEqual(phone.width);
            expect(center.y - size / 2).toBeGreaterThanOrEqual(insets.top);
            expect(center.y + size / 2).toBeLessThanOrEqual(phone.height - insets.bottom);
            expect(distance(center, origin)).toBeGreaterThanOrEqual(
              (FAB_SIZE * HOLD_SCALE + size) / 2,
            );
          }
          for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
              const gap = distance(items[i].center, items[j].center);
              expect(gap).toBeGreaterThanOrEqual((items[i].size + items[j].size) / 2);
            }
          }
        });
      }
    }
  }

  it("lists favorites top to bottom on both edges", () => {
    for (const edge of edges) {
      const layout = fanLayout(fabCenter(edge, 426, phone, insets), edge, phone, insets, 4);
      const ys = layout.favorites.map((p) => p.y);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
    }
  });

  it("keeps the arc compact when the middle of the screen has room for it", () => {
    for (const edge of edges) {
      const origin = fabCenter(edge, 426, phone, insets);
      const layout = fanLayout(origin, edge, phone, insets, 5);
      for (const favorite of layout.favorites) {
        expect(distance(favorite, origin)).toBeLessThan(130);
      }
    }
  });

  it("opens away from the edge the button rests on", () => {
    const left = fanLayout(fabCenter("left", 426, phone, insets), "left", phone, insets, 4);
    const right = fanLayout(fabCenter("right", 426, phone, insets), "right", phone, insets, 4);
    expect(left.favorites.every((p) => p.x > FAB_SIZE)).toBe(true);
    expect(right.favorites.every((p) => p.x < phone.width - FAB_SIZE)).toBe(true);
  });

  it("puts settings farther out than every favorite and clear of the arc", () => {
    const origin = fabCenter("right", 426, phone, insets);
    const layout = fanLayout(origin, "right", phone, insets, 4);
    const settings = distance(origin, layout.settings);
    for (const favorite of layout.favorites) {
      expect(settings).toBeGreaterThan(distance(origin, favorite));
      expect(distance(layout.settings, favorite)).toBeGreaterThan(FAVORITE_SIZE);
    }
  });

  it("stacks history directly above settings in the same column", () => {
    for (const edge of edges) {
      for (const y of heights) {
        const origin = fabCenter(edge, y, phone, insets);
        const layout = fanLayout(origin, edge, phone, insets, 4);
        expect(layout.history.x).toBe(layout.settings.x);
        expect(layout.history.y).toBeLessThan(layout.settings.y);
      }
    }
  });

  it("stacks stats directly above history in the same column", () => {
    for (const edge of edges) {
      for (const y of heights) {
        for (const count of [0, 6]) {
          const origin = fabCenter(edge, y, phone, insets);
          const layout = fanLayout(origin, edge, phone, insets, count);
          expect(layout.stats.x).toBe(layout.history.x);
          expect(layout.stats.y).toBeLessThan(layout.history.y);
        }
      }
    }
  });

  it("puts incognito at the top of the column, directly above usage", () => {
    for (const edge of edges) {
      for (const y of heights) {
        for (const count of [0, 6]) {
          const origin = fabCenter(edge, y, phone, insets);
          const layout = fanLayout(origin, edge, phone, insets, count);
          expect(layout.incognito.x).toBe(layout.stats.x);
          expect(layout.incognito.y).toBeLessThan(layout.stats.y);
        }
      }
    }
  });
});

describe("fanTargetAt", () => {
  const origin = fabCenter("left", 426, phone, insets);
  const layout = fanLayout(origin, "left", phone, insets, 4);

  it("finds the item under the finger", () => {
    expect(fanTargetAt(layout.favorites[2], layout)).toEqual({ kind: "favorite", index: 2 });
    expect(fanTargetAt(layout.settings, layout)).toEqual({ kind: "settings" });
    expect(fanTargetAt(layout.history, layout)).toEqual({ kind: "history" });
    expect(fanTargetAt(layout.stats, layout)).toEqual({ kind: "stats" });
    expect(fanTargetAt(layout.incognito, layout)).toEqual({ kind: "incognito" });
  });

  it("returns null away from every item", () => {
    expect(fanTargetAt({ x: 380, y: 10 }, layout)).toBeNull();
  });
});
