import { describe, expect, it } from "vitest";
import {
  FAB_SIZE,
  FAVORITE_SIZE,
  HISTORY_SIZE,
  HOLD_SCALE,
  COLOR_PICKER_SIZE,
  CONTROLS_SIZE,
  DARK_MODE_SIZE,
  TECH_DETECTOR_SIZE,
  INCOGNITO_SIZE,
  SETTINGS_SIZE,
  STATS_SIZE,
  TABS_SIZE,
  fabCenter,
  fanLayout,
  fanTargetAt,
  HIDE_REACH,
  PEEK_HEIGHT,
  peekCenterY,
  pushedOffEdge,
  separateVerticalPosition,
  snapToEdge,
  type Edge,
  type FanExtras,
  type FanLayout,
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

const ALL_EXTRAS: FanExtras = { colorPicker: true, techDetector: true };
const EXTRA_CHOICES: FanExtras[] = [
  { colorPicker: false, techDetector: false },
  { colorPicker: true, techDetector: false },
  { colorPicker: false, techDetector: true },
  ALL_EXTRAS,
];

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe("fanLayout", () => {
  const edges: Edge[] = ["left", "right"];
  const heights = [insets.top, 200, 426, 700, phone.height - insets.bottom];

  for (const edge of edges) {
    for (const y of heights) {
      for (const [count, extras] of [0, 1, 2, 4, 6].flatMap((n) =>
        EXTRA_CHOICES.map((choice) => [n, choice] as const),
      )) {
        it(`keeps ${count} favorites on screen and apart (${edge} edge, y=${y}, ${JSON.stringify(extras)})`, () => {
          const origin = fabCenter(edge, y, phone, insets);
          const layout = fanLayout(origin, edge, phone, insets, count, extras);
          expect(layout.colorPicker === null).toBe(!extras.colorPicker);
          expect(layout.techDetector === null).toBe(!extras.techDetector);
          const items = [
            ...layout.favorites.map((center) => ({ center, size: FAVORITE_SIZE })),
            { center: layout.settings, size: SETTINGS_SIZE },
            { center: layout.history, size: HISTORY_SIZE },
            { center: layout.tabs, size: TABS_SIZE },
            { center: layout.stats, size: STATS_SIZE },
            { center: layout.incognito, size: INCOGNITO_SIZE },
            { center: layout.controls, size: CONTROLS_SIZE },
            { center: layout.darkMode, size: DARK_MODE_SIZE },
            ...(layout.colorPicker
              ? [{ center: layout.colorPicker, size: COLOR_PICKER_SIZE }]
              : []),
            ...(layout.techDetector
              ? [{ center: layout.techDetector, size: TECH_DETECTOR_SIZE }]
              : []),
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
      const layout = fanLayout(
        fabCenter(edge, 426, phone, insets),
        edge,
        phone,
        insets,
        4,
        ALL_EXTRAS,
      );
      const ys = layout.favorites.map((p) => p.y);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
    }
  });

  it("keeps the arc compact when the middle of the screen has room for it", () => {
    for (const edge of edges) {
      const origin = fabCenter(edge, 426, phone, insets);
      const layout = fanLayout(origin, edge, phone, insets, 5, ALL_EXTRAS);
      for (const favorite of layout.favorites) {
        expect(distance(favorite, origin)).toBeLessThan(130);
      }
    }
  });

  it("opens away from the edge the button rests on", () => {
    const left = fanLayout(
      fabCenter("left", 426, phone, insets),
      "left",
      phone,
      insets,
      4,
      ALL_EXTRAS,
    );
    const right = fanLayout(
      fabCenter("right", 426, phone, insets),
      "right",
      phone,
      insets,
      4,
      ALL_EXTRAS,
    );
    expect(left.favorites.every((p) => p.x > FAB_SIZE)).toBe(true);
    expect(right.favorites.every((p) => p.x < phone.width - FAB_SIZE)).toBe(true);
  });

  it("puts settings farther out than every favorite and clear of the arc", () => {
    const origin = fabCenter("right", 426, phone, insets);
    const layout = fanLayout(origin, "right", phone, insets, 4, ALL_EXTRAS);
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
        const layout = fanLayout(origin, edge, phone, insets, 4, ALL_EXTRAS);
        expect(layout.history.x).toBe(layout.settings.x);
        expect(layout.history.y).toBeLessThan(layout.settings.y);
      }
    }
  });

  it("stacks tabs directly above history in the same column", () => {
    for (const edge of edges) {
      for (const y of heights) {
        for (const count of [0, 6]) {
          const origin = fabCenter(edge, y, phone, insets);
          const layout = fanLayout(origin, edge, phone, insets, count, ALL_EXTRAS);
          expect(layout.tabs.x).toBe(layout.history.x);
          expect(layout.tabs.y).toBeLessThan(layout.history.y);
        }
      }
    }
  });

  it("stacks stats directly above tabs in the same column", () => {
    for (const edge of edges) {
      for (const y of heights) {
        for (const count of [0, 6]) {
          const origin = fabCenter(edge, y, phone, insets);
          const layout = fanLayout(origin, edge, phone, insets, count, ALL_EXTRAS);
          expect(layout.stats.x).toBe(layout.tabs.x);
          expect(layout.stats.y).toBeLessThan(layout.tabs.y);
        }
      }
    }
  });

  it("puts incognito and the controls switch across the button from the page column when there is room", () => {
    for (const edge of edges) {
      for (const count of [0, 1, 2, 4]) {
        const origin = fabCenter(edge, 426, phone, insets);
        const layout = fanLayout(origin, edge, phone, insets, count, ALL_EXTRAS);
        const pageSide = Math.sign(layout.settings.y - origin.y);
        expect(layout.incognito.x).toBe(origin.x);
        expect(layout.controls.x).toBe(origin.x);
        expect(layout.darkMode.x).toBe(origin.x);
        for (const page of [layout.settings, layout.history, layout.tabs, layout.stats])
          expect(Math.sign(page.y - origin.y)).toBe(pageSide);
        expect(Math.sign(layout.incognito.y - origin.y)).toBe(-pageSide);
        expect(Math.sign(layout.controls.y - origin.y)).toBe(-pageSide);
        expect(Math.sign(layout.darkMode.y - origin.y)).toBe(-pageSide);
        expect(layout.colorPicker?.x).toBe(origin.x);
        expect(Math.sign((layout.colorPicker?.y ?? 0) - origin.y)).toBe(-pageSide);
        expect(layout.techDetector?.x).toBe(origin.x);
        expect(Math.sign((layout.techDetector?.y ?? 0) - origin.y)).toBe(-pageSide);
      }
    }
  });

  it("continues the page column with incognito and the controls switch near the screen edge", () => {
    for (const edge of edges) {
      const origin = fabCenter(edge, insets.top, phone, insets);
      const layout = fanLayout(origin, edge, phone, insets, 0, ALL_EXTRAS);
      expect(layout.incognito.x).toBe(layout.stats.x);
      expect(layout.incognito.y).toBeLessThan(layout.stats.y);
      expect(layout.controls.x).toBe(layout.stats.x);
      expect(layout.controls.y).toBeLessThan(layout.incognito.y);
      expect(layout.darkMode.x).toBe(layout.stats.x);
      expect(layout.darkMode.y).toBeLessThan(layout.controls.y);
      expect(layout.colorPicker?.x).toBe(layout.stats.x);
      expect(layout.colorPicker?.y).toBeLessThan(layout.darkMode.y);
      expect(layout.techDetector?.x).toBe(layout.stats.x);
      expect(layout.techDetector?.y).toBeLessThan(layout.colorPicker?.y ?? 0);
    }
  });
});

function techOf(layout: FanLayout): Point {
  if (!layout.techDetector) throw new Error("the layout has no technology detector");
  return layout.techDetector;
}

function pickerOf(layout: FanLayout): Point {
  if (!layout.colorPicker) throw new Error("the layout has no color picker");
  return layout.colorPicker;
}

describe("the dark mode button", () => {
  it("sits right after the controls switch and never overlaps another item", () => {
    for (const edge of ["left", "right"] as const) {
      for (const y of [insets.top, 200, 426, 700, phone.height - insets.bottom]) {
        for (const extras of EXTRA_CHOICES) {
          const origin = fabCenter(edge, y, phone, insets);
          const layout = fanLayout(origin, edge, phone, insets, 4, extras);
          expect(distance(layout.darkMode, layout.controls)).toBeCloseTo(52);
          const others = [
            ...layout.favorites,
            layout.settings,
            layout.history,
            layout.tabs,
            layout.stats,
            layout.incognito,
            layout.controls,
            ...(layout.colorPicker ? [layout.colorPicker] : []),
            ...(layout.techDetector ? [layout.techDetector] : []),
          ];
          for (const other of others) {
            expect(distance(layout.darkMode, other)).toBeGreaterThan(DARK_MODE_SIZE);
          }
        }
      }
    }
  });
});

describe("fanTargetAt", () => {
  const origin = fabCenter("left", 426, phone, insets);
  const layout = fanLayout(origin, "left", phone, insets, 4, ALL_EXTRAS);

  it("finds the item under the finger", () => {
    expect(fanTargetAt(layout.favorites[2], layout)).toEqual({ kind: "favorite", index: 2 });
    expect(fanTargetAt(layout.settings, layout)).toEqual({ kind: "settings" });
    expect(fanTargetAt(layout.history, layout)).toEqual({ kind: "history" });
    expect(fanTargetAt(layout.tabs, layout)).toEqual({ kind: "tabs" });
    expect(fanTargetAt(layout.stats, layout)).toEqual({ kind: "stats" });
    expect(fanTargetAt(layout.incognito, layout)).toEqual({ kind: "incognito" });
    expect(fanTargetAt(layout.controls, layout)).toEqual({ kind: "controls" });
    expect(fanTargetAt(layout.darkMode, layout)).toEqual({ kind: "darkMode" });
    expect(fanTargetAt(pickerOf(layout), layout)).toEqual({ kind: "colorPicker" });
    expect(fanTargetAt(techOf(layout), layout)).toEqual({ kind: "techDetector" });
  });

  it("stacks the technology detector straight after the dark mode switch when the picker is off", () => {
    const only = fanLayout(origin, "left", phone, insets, 4, {
      colorPicker: false,
      techDetector: true,
    });
    const both = layout;
    expect(distance(only.techDetector ?? origin, only.darkMode)).toBeCloseTo(
      distance(both.colorPicker ?? origin, both.darkMode),
    );
  });

  it("has no color picker to find when it is turned off", () => {
    const without = fanLayout(origin, "left", phone, insets, 4, {
      colorPicker: false,
      techDetector: false,
    });
    expect(without.colorPicker).toBeNull();
    expect(without.techDetector).toBeNull();
    expect(fanTargetAt(pickerOf(layout), without)?.kind).not.toBe("colorPicker");
    expect(fanTargetAt(techOf(layout), without)?.kind).not.toBe("techDetector");
  });

  it("returns null away from every item", () => {
    expect(fanTargetAt({ x: 380, y: 10 }, layout)).toBeNull();
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
