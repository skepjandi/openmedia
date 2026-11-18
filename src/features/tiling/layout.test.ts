import { describe, expect, it } from "vitest";
import type { Tiles } from "../../shared/ipc";
import {
  GAP,
  MAX_PANES,
  arrange,
  asLayout,
  dividers,
  dropArea,
  dropZone,
  equalize,
  flipPane,
  fromTiles,
  insertPane,
  leaves,
  neighbor,
  neighborOf,
  pane,
  paneRects,
  place,
  ratioAt,
  removePane,
  replacePane,
  resizePane,
  setRatio,
  successorOf,
  swapPanes,
  tilesForFolder,
  tileUrls,
  withoutSessions,
  toTiles,
  type Layout,
} from "./layout";

const area = { x: 0, y: 0, width: 1006, height: 500 };

const row = (first: Layout, second: Layout, ratio = 0.5): Layout => ({
  kind: "split",
  direction: "row",
  ratio,
  first,
  second,
});
const column = (first: Layout, second: Layout, ratio = 0.5): Layout => ({
  kind: "split",
  direction: "column",
  ratio,
  first,
  second,
});

describe("inserting and removing windows", () => {
  it("puts the new window on the side it was dropped on, taking half", () => {
    expect(insertPane(pane("a"), "a", "right", "b")).toEqual(row(pane("a"), pane("b")));
    expect(insertPane(pane("a"), "a", "left", "b")).toEqual(row(pane("b"), pane("a")));
    expect(insertPane(pane("a"), "a", "top", "b")).toEqual(column(pane("b"), pane("a")));
    expect(insertPane(pane("a"), "a", "bottom", "b")).toEqual(column(pane("a"), pane("b")));
  });

  it("splits only the window it was dropped on", () => {
    const next = insertPane(row(pane("a"), pane("b")), "b", "bottom", "c");
    expect(next).toEqual(row(pane("a"), column(pane("b"), pane("c"))));
  });

  it("refuses a page already shown and a layout that is full", () => {
    const two = row(pane("a"), pane("b"));
    expect(insertPane(two, "a", "left", "b")).toBe(two);
    let full: Layout = pane("p0");
    for (let i = 1; i < MAX_PANES; i += 1) full = insertPane(full, "p0", "right", `p${i}`);
    expect(leaves(full)).toHaveLength(MAX_PANES);
    expect(insertPane(full, "p0", "right", "extra")).toBe(full);
  });

  it("gives a closed window's room to its neighbour", () => {
    const layout = row(pane("a"), column(pane("b"), pane("c")));
    expect(removePane(layout, "b")).toEqual(row(pane("a"), pane("c")));
    expect(removePane(layout, "a")).toEqual(column(pane("b"), pane("c")));
    expect(removePane(pane("a"), "a")).toBeNull();
  });

  it("names the window that takes over when one closes", () => {
    const layout = row(pane("a"), column(pane("b"), pane("c")));
    expect(successorOf(layout, "a")).toBe("b");
    expect(successorOf(layout, "b")).toBe("c");
    expect(successorOf(layout, "c")).toBe("b");
    expect(successorOf(row(column(pane("a"), pane("b")), pane("c")), "c")).toBe("b");
  });

  it("is no layout with a single window", () => {
    expect(asLayout(pane("a"))).toBeNull();
    expect(asLayout(null)).toBeNull();
    expect(asLayout(row(pane("a"), pane("b")))).not.toBeNull();
  });

  it("swaps two windows without touching sizes", () => {
    const layout = row(pane("a"), column(pane("b"), pane("c"), 0.3), 0.7);
    expect(swapPanes(layout, "a", "c")).toEqual(
      row(pane("c"), column(pane("b"), pane("a"), 0.3), 0.7),
    );
  });

  it("changes the page in a window in place", () => {
    const layout = row(pane("a"), pane("b"));
    expect(replacePane(layout, "a", "z")).toEqual(row(pane("z"), pane("b")));
    expect(replacePane(layout, "a", "b")).toBe(layout);
  });
});

describe("laying windows out", () => {
  it("splits the room around a gap", () => {
    const rects = paneRects(row(pane("a"), pane("b")), area);
    expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    expect(rects.get("b")).toEqual({ x: 500 + GAP, y: 0, width: 500, height: 500 });
  });

  it("stacks a column and nests splits", () => {
    const rects = paneRects(row(pane("a"), column(pane("b"), pane("c"))), area);
    expect(rects.get("b")?.height).toBe(247);
    expect(rects.get("c")?.y).toBe(247 + GAP);
    expect(rects.get("c")?.x).toBe(rects.get("b")?.x);
  });

  it("places the handle in the gap and reads a drag back as a ratio", () => {
    const layout = row(pane("a"), pane("b"), 0.5);
    const [divider] = dividers(layout, area);
    expect(divider.rect).toEqual({ x: 500, y: 0, width: GAP, height: 500 });
    expect(ratioAt(divider, { x: 500 + GAP / 2, y: 10 })).toBeCloseTo(0.5, 5);
    expect(ratioAt(divider, { x: 0, y: 0 })).toBeCloseTo(0.12, 5);
    expect(ratioAt(divider, { x: 5000, y: 0 })).toBeCloseTo(0.88, 5);
  });

  it("resizes the split found by its path", () => {
    const layout = row(pane("a"), column(pane("b"), pane("c")));
    const next = setRatio(layout, [1], 0.25);
    expect(next.kind === "split" && next.second.kind === "split" && next.second.ratio).toBe(0.25);
  });

  it("grows a window toward its sibling and stops at the limit", () => {
    const layout = row(pane("a"), pane("b"));
    const grown = resizePane(layout, "a", 0.1);
    expect(grown.kind === "split" && grown.ratio).toBeCloseTo(0.6);
    const shrunk = resizePane(layout, "b", 0.1);
    expect(shrunk.kind === "split" && shrunk.ratio).toBeCloseTo(0.4);
    const limit = resizePane(row(pane("a"), pane("b"), 0.88), "a", 0.1);
    expect(limit.kind === "split" && limit.ratio).toBeCloseTo(0.88);
  });

  it("equalizes by how many windows each side holds", () => {
    const layout = row(pane("a"), row(pane("b"), pane("c"), 0.9), 0.1);
    const even = equalize(layout);
    expect(even.kind === "split" && even.ratio).toBeCloseTo(1 / 3);
    const nested = even.kind === "split" ? even.second : null;
    expect(nested?.kind === "split" && nested.ratio).toBe(0.5);
  });
});

describe("moving between windows", () => {
  const rects = paneRects(row(pane("a"), column(pane("b"), pane("c"))), area);

  it("finds the window in each direction", () => {
    expect(neighbor(rects, "a", "right")).toBe("b");
    expect(neighbor(rects, "b", "left")).toBe("a");
    expect(neighbor(rects, "b", "down")).toBe("c");
    expect(neighbor(rects, "c", "up")).toBe("b");
  });

  it("finds nothing past an edge", () => {
    expect(neighbor(rects, "a", "left")).toBeNull();
    expect(neighbor(rects, "a", "up")).toBeNull();
    expect(neighbor(rects, "c", "right")).toBeNull();
    expect(neighbor(rects, "nobody", "left")).toBeNull();
  });
});

describe("dropping a page", () => {
  const rects = paneRects(row(pane("a"), pane("b")), area);

  it("reads the side from where in the window the pointer is", () => {
    expect(dropZone(rects, { x: 20, y: 250 })).toEqual({ id: "a", drop: "left" });
    expect(dropZone(rects, { x: 480, y: 250 })).toEqual({ id: "a", drop: "right" });
    expect(dropZone(rects, { x: 250, y: 10 })).toEqual({ id: "a", drop: "top" });
    expect(dropZone(rects, { x: 750, y: 490 })).toEqual({ id: "b", drop: "bottom" });
    expect(dropZone(rects, { x: 750, y: 250 })).toEqual({ id: "b", drop: "center" });
  });

  it("finds nothing outside the windows", () => {
    expect(dropZone(rects, { x: -5, y: 10 })).toBeNull();
    expect(dropZone(rects, { x: 502, y: 10 })).toBeNull();
  });

  it("highlights the half a page would take", () => {
    const rect = { x: 10, y: 20, width: 200, height: 100 };
    expect(dropArea(rect, "left")).toEqual({ x: 10, y: 20, width: 100, height: 100 });
    expect(dropArea(rect, "right")).toEqual({ x: 110, y: 20, width: 100, height: 100 });
    expect(dropArea(rect, "top")).toEqual({ x: 10, y: 20, width: 200, height: 50 });
    expect(dropArea(rect, "bottom")).toEqual({ x: 10, y: 70, width: 200, height: 50 });
    expect(dropArea(rect, "center")).toEqual(rect);
  });
});

describe("the layout after a page comes to the front", () => {
  it("lands beside the page in front when dropped on a lone page", () => {
    const next = place(null, "a", "b", { target: "a", drop: "right" });
    expect(next).toEqual(row(pane("a"), pane("b")));
  });

  it("moves a page already shown instead of showing it twice", () => {
    const layout = row(pane("a"), row(pane("b"), pane("c")));
    const next = place(layout, "a", "c", { target: "a", drop: "left" });
    expect(next).toEqual(row(row(pane("c"), pane("a")), pane("b")));
    expect(leaves(next as Layout).sort()).toEqual(["a", "b", "c"]);
  });

  it("replaces the target for a drop on the middle, and a lone page leaves no layout", () => {
    const layout = row(pane("a"), pane("b"));
    expect(place(layout, "a", "z", { target: "b", drop: "center" })).toEqual(
      row(pane("a"), pane("z")),
    );
    expect(place(null, "a", "z", { target: "a", drop: "center" })).toBeNull();
  });

  it("replaces the target instead when the layout is full", () => {
    let full: Layout = pane("p0");
    for (let i = 1; i < MAX_PANES; i += 1) full = insertPane(full, "p0", "right", `p${i}`);
    const next = place(full, "p0", "extra", { target: "p0", drop: "left" }) as Layout;
    expect(leaves(next)).toHaveLength(MAX_PANES);
    expect(leaves(next)).toContain("extra");
    expect(leaves(next)).not.toContain("p0");
  });

  it("without a drop, a new page takes over the window in front", () => {
    const layout = row(pane("a"), pane("b"));
    expect(place(layout, "b", "z", null)).toEqual(row(pane("a"), pane("z")));
  });

  it("without a drop, a page already shown is just focused", () => {
    const layout = row(pane("a"), pane("b"));
    expect(place(layout, "a", "b", null)).toBe(layout);
  });

  it("stays no layout when there was none", () => {
    expect(place(null, "a", "b", null)).toBeNull();
  });

  it("falls back to the plain rule when the drop names a window that is gone", () => {
    const layout = row(pane("a"), pane("b"));
    expect(place(layout, "a", "z", { target: "gone", drop: "left" })).toEqual(
      row(pane("z"), pane("b")),
    );
  });
});

describe("saving a layout", () => {
  const layout = row(pane("a"), column(pane("b"), pane("c"), 0.3), 0.7);
  const urls: Record<string, string> = {
    a: "https://a.example/",
    b: "https://b.example/",
    c: "https://c.example/",
  };

  it("keeps each window by its address and the sizes", () => {
    const tiles = toTiles(layout, (id) => urls[id] ?? null);
    expect(tiles).toEqual({
      kind: "split",
      direction: "row",
      ratio: 0.7,
      first: { kind: "pane", url: urls.a },
      second: {
        kind: "split",
        direction: "column",
        ratio: 0.3,
        first: { kind: "pane", url: urls.b },
        second: { kind: "pane", url: urls.c },
      },
    });
  });

  it("drops a window with no address", () => {
    const tiles = toTiles(layout, (id) => (id === "b" ? null : urls[id]));
    expect(tiles && leaves(fromTiles(tiles, (url) => url))).toEqual([urls.a, urls.c]);
  });

  it("builds the windows back in order, one session per window", () => {
    const tiles = toTiles(layout, (id) => urls[id] ?? null) as Tiles;
    const restored = fromTiles(tiles, (_url, index) => `s${index}`);
    expect(restored).toEqual(row(pane("s0"), column(pane("s1"), pane("s2"), 0.3), 0.7));
  });

  it("keeps a restored ratio inside the limits", () => {
    const restored = fromTiles(
      {
        kind: "split",
        direction: "row",
        ratio: 0.99,
        first: { kind: "pane", url: "https://a.example/" },
        second: { kind: "pane", url: "https://b.example/" },
      },
      (_url, index) => `s${index}`,
    );
    expect(restored.kind === "split" && restored.ratio).toBeCloseTo(0.88);
  });
});

describe("closing sessions under a layout", () => {
  const layout = row(pane("a"), column(pane("b"), pane("c")));

  it("hands the front to the window that took the closed one's room", () => {
    const next = withoutSessions(layout, "b", ["b"]);
    expect(next.layout).toEqual(row(pane("a"), pane("c")));
    expect(next.activeId).toBe("c");
  });

  it("keeps the front where it was when another window closes", () => {
    const next = withoutSessions(layout, "a", ["c"]);
    expect(next.layout).toEqual(row(pane("a"), pane("b")));
    expect(next.activeId).toBe("a");
  });

  it("is no layout once one window is left, and that window is in front", () => {
    const next = withoutSessions(row(pane("a"), pane("b")), "a", ["a"]);
    expect(next.layout).toBeNull();
    expect(next.activeId).toBe("b");
  });

  it("closes several at once and leaves a layout of one session out", () => {
    const next = withoutSessions(layout, "a", ["b", "c"]);
    expect(next.layout).toBeNull();
    expect(next.activeId).toBe("a");
  });

  it("changes nothing for sessions that are not windows", () => {
    expect(withoutSessions(layout, "a", ["x"])).toEqual({ layout, activeId: "a" });
    expect(withoutSessions(null, "a", ["a"])).toEqual({ layout: null, activeId: "a" });
  });
});

describe("moving by how the layout is arranged", () => {
  it("finds neighbours without knowing the size of the area", () => {
    const layout = row(pane("a"), column(pane("b"), pane("c")));
    expect(neighborOf(layout, "a", "right")).toBe("b");
    expect(neighborOf(layout, "c", "left")).toBe("a");
    expect(neighborOf(layout, "c", "up")).toBe("b");
    expect(neighborOf(layout, "b", "up")).toBeNull();
  });
});

describe("arranging windows again", () => {
  const layout = row(pane("a"), column(pane("b"), pane("c")));

  it("lays every window out side by side or stacked, keeping their order and giving each the same room", () => {
    const sideBySide = arrange(layout, "row");
    expect(leaves(sideBySide)).toEqual(["a", "b", "c"]);
    const rects = paneRects(sideBySide, { x: 0, y: 0, width: 906, height: 100 }, 0);
    expect([...rects.values()].map((rect) => Math.round(rect.width))).toEqual([302, 302, 302]);
    const stacked = paneRects(
      arrange(layout, "column"),
      { x: 0, y: 0, width: 100, height: 900 },
      0,
    );
    expect([...stacked.values()].map((rect) => Math.round(rect.height))).toEqual([300, 300, 300]);
  });

  it("makes a grid of four", () => {
    const grid = paneRects(
      arrange(row(pane("a"), row(pane("b"), row(pane("c"), pane("d")))), "grid"),
      { x: 0, y: 0, width: 200, height: 200 },
      0,
    );
    expect([...grid.values()].map((r) => [r.x, r.y, r.width, r.height])).toEqual([
      [0, 0, 100, 100],
      [0, 100, 100, 100],
      [100, 0, 100, 100],
      [100, 100, 100, 100],
    ]);
  });

  it("turns the split that holds the window", () => {
    expect(flipPane(row(pane("a"), pane("b")), "a")).toEqual(column(pane("a"), pane("b")));
    const nested = row(pane("a"), column(pane("b"), pane("c")));
    expect(flipPane(nested, "c")).toEqual(row(pane("a"), row(pane("b"), pane("c"))));
    expect(flipPane(pane("a"), "a")).toEqual(pane("a"));
  });
});

describe("what a folder opens as", () => {
  const member = (name: string) => ({
    url: `https://${name}.example/`,
    start: `https://${name}.example/home`,
  });
  const urls = (tiles: Tiles | null) => (tiles ? tileUrls(tiles) : null);

  it("is a default arrangement without a saved layout", () => {
    expect(tilesForFolder(null, [member("a")])).toBeNull();
    expect(urls(tilesForFolder(null, [member("a"), member("b")]))).toEqual([
      "https://a.example/home",
      "https://b.example/home",
    ]);
    const three = tilesForFolder(null, [member("a"), member("b"), member("c")]) as Tiles;
    expect(three.kind === "split" && three.direction === "row" && three.second.kind).toBe("split");
  });

  it("keeps at most eight windows", () => {
    const many = "abcdefghij".split("").map(member);
    expect(urls(tilesForFolder(null, many))).toHaveLength(8);
  });

  it("keeps a saved layout, by each favorite's start address", () => {
    const saved = toTiles(
      column(pane("https://b.example/"), pane("https://a.example/")),
      (id) => id,
    ) as Tiles;
    const tiles = tilesForFolder(saved, [member("a"), member("b")]) as Tiles;
    expect(tiles.kind === "split" && tiles.direction).toBe("column");
    expect(urls(tiles)).toEqual(["https://b.example/home", "https://a.example/home"]);
  });

  it("drops a window whose favorite left and adds one that joined", () => {
    const saved = toTiles(
      row(
        pane("https://a.example/"),
        row(pane("https://gone.example/"), pane("https://b.example/")),
      ),
      (id) => id,
    ) as Tiles;
    const tiles = tilesForFolder(saved, [member("a"), member("b"), member("new")]);
    expect(urls(tiles)).toEqual([
      "https://a.example/home",
      "https://b.example/home",
      "https://new.example/home",
    ]);
  });

  it("falls back to the default when too little of the saved layout is left", () => {
    const saved = toTiles(
      row(pane("https://x.example/"), pane("https://y.example/")),
      (id) => id,
    ) as Tiles;
    expect(urls(tilesForFolder(saved, [member("a"), member("b")]))).toEqual([
      "https://a.example/home",
      "https://b.example/home",
    ]);
  });
});
