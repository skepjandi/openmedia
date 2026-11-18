import type { Rect, TileDirection, Tiles } from "../../shared/ipc";

/** A side of a window, or its middle: where a dragged page lands on the window under it. */
export type Side = "left" | "right" | "top" | "bottom";
export type Drop = Side | "center";

/** `row` puts the two halves side by side, `column` stacks them. */
export type Direction = TileDirection;

/** One window: the session whose page it shows. */
export interface Pane {
  kind: "pane";
  id: string;
}

/** Two halves of a rectangle. `ratio` is the share the first half takes of the room left after the gap. */
export interface Split {
  kind: "split";
  direction: Direction;
  ratio: number;
  first: Layout;
  second: Layout;
}

/** How the page area is divided into windows. Absent (null elsewhere) means one page fills it. */
export type Layout = Pane | Split;

/** The most windows one layout holds; Rust enforces the same number for a saved one. */
export const MAX_PANES = 8;
/** The room between two windows, where the handle that resizes them sits. */
export const GAP = 6;
/** The strip above a window that names its page and holds its buttons. */
export const HEADER = 28;
/** The smallest share either half of a split may take. */
export const MIN_RATIO = 0.12;
/** How far in from a window's edge a drop still counts as that side. */
const EDGE_SHARE = 0.27;
/** How much one grow or shrink step moves a split. */
export const RESIZE_STEP = 0.05;

export const pane = (id: string): Pane => ({ kind: "pane", id });

export function leaves(layout: Layout): string[] {
  return layout.kind === "pane" ? [layout.id] : [...leaves(layout.first), ...leaves(layout.second)];
}

export const contains = (layout: Layout, id: string): boolean => leaves(layout).includes(id);

/** A layout of one window is no layout: the page then fills the area, as it always did. */
export const asLayout = (layout: Layout | null): Layout | null =>
  layout !== null && leaves(layout).length >= 2 ? layout : null;

const clampRatio = (ratio: number): number => Math.min(Math.max(ratio, MIN_RATIO), 1 - MIN_RATIO);

const split = (direction: Direction, first: Layout, second: Layout, ratio = 0.5): Split => ({
  kind: "split",
  direction,
  ratio,
  first,
  second,
});

function mapPane(layout: Layout, id: string, change: (leaf: Pane) => Layout): Layout {
  if (layout.kind === "pane") return layout.id === id ? change(layout) : layout;
  const first = mapPane(layout.first, id, change);
  const second = mapPane(layout.second, id, change);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/** Where a new window goes when dropped on `side` of `target`: that side of it, taking half. */
export function insertPane(layout: Layout, target: string, side: Side, id: string): Layout {
  if (!contains(layout, target) || contains(layout, id) || leaves(layout).length >= MAX_PANES) {
    return layout;
  }
  return mapPane(layout, target, (leaf) => {
    const added = pane(id);
    switch (side) {
      case "left":
        return split("row", added, leaf);
      case "right":
        return split("row", leaf, added);
      case "top":
        return split("column", added, leaf);
      case "bottom":
        return split("column", leaf, added);
    }
  });
}

/** The layout without window `id`; its neighbour takes the room. Null when none is left. */
export function removePane(layout: Layout, id: string): Layout | null {
  if (layout.kind === "pane") return layout.id === id ? null : layout;
  const first = removePane(layout.first, id);
  const second = removePane(layout.second, id);
  if (first === null) return second;
  if (second === null) return first;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/** Window `id` shows another page; where it stands is unchanged. */
export function replacePane(layout: Layout, id: string, replacement: string): Layout {
  if (id === replacement || contains(layout, replacement)) return layout;
  return mapPane(layout, id, () => pane(replacement));
}

/** The two windows trade places and keep their sizes. */
export function swapPanes(layout: Layout, a: string, b: string): Layout {
  if (a === b || !contains(layout, a) || !contains(layout, b)) return layout;
  const swap = (node: Layout): Layout => {
    if (node.kind === "pane") return node.id === a ? pane(b) : node.id === b ? pane(a) : node;
    return { ...node, first: swap(node.first), second: swap(node.second) };
  };
  return swap(layout);
}

/** The window that takes the room when `id` leaves: its sibling's nearest window. */
export function successorOf(layout: Layout, id: string): string | null {
  if (layout.kind === "pane") return null;
  const inFirst = contains(layout.first, id);
  const near = inFirst ? layout.second : layout.first;
  const inner = inFirst ? successorOf(layout.first, id) : successorOf(layout.second, id);
  if (inner !== null) return inner;
  const sibling = inFirst ? layout.first : layout.second;
  if (sibling.kind === "pane" && sibling.id === id) {
    const order = leaves(near);
    return inFirst ? order[0] : order[order.length - 1];
  }
  return null;
}

/** Every split gets the share its windows count for, so all windows come out about as large. */
export function equalize(layout: Layout): Layout {
  if (layout.kind === "pane") return layout;
  const first = equalize(layout.first);
  const second = equalize(layout.second);
  const share = (node: Layout, direction: Direction): number =>
    node.kind === "split" && node.direction === direction
      ? share(node.first, direction) + share(node.second, direction)
      : 1;
  const a = share(first, layout.direction);
  const b = share(second, layout.direction);
  return { ...layout, first, second, ratio: a / (a + b) };
}

/** Moves the edge of window `id` that faces its sibling; `delta` is a share of the split. */
export function resizePane(layout: Layout, id: string, delta: number): Layout {
  if (layout.kind === "pane") return layout;
  const inFirst = contains(layout.first, id);
  const inSecond = contains(layout.second, id);
  if (!inFirst && !inSecond) return layout;
  const inner = inFirst ? layout.first : layout.second;
  if (inner.kind === "split" && contains(inner, id)) {
    const resized = resizePane(inner, id, delta);
    if (resized !== inner) {
      return inFirst ? { ...layout, first: resized } : { ...layout, second: resized };
    }
  }
  const ratio = clampRatio(layout.ratio + (inFirst ? delta : -delta));
  return ratio === layout.ratio ? layout : { ...layout, ratio };
}

/** A split's place in the tree: 0 goes to its first half, 1 to its second. */
export type Path = readonly (0 | 1)[];

/** Sets one split's ratio, found by `path`. */
export function setRatio(layout: Layout, path: Path, ratio: number): Layout {
  if (layout.kind === "pane") return layout;
  if (path.length === 0) return { ...layout, ratio: clampRatio(ratio) };
  const [step, ...rest] = path;
  return step === 0
    ? { ...layout, first: setRatio(layout.first, rest, ratio) }
    : { ...layout, second: setRatio(layout.second, rest, ratio) };
}

function halves(rect: Rect, direction: Direction, ratio: number, gap: number): [Rect, Rect] {
  if (direction === "row") {
    const room = Math.max(rect.width - gap, 0);
    const first = room * ratio;
    return [
      { ...rect, width: first },
      { ...rect, x: rect.x + first + gap, width: room - first },
    ];
  }
  const room = Math.max(rect.height - gap, 0);
  const first = room * ratio;
  return [
    { ...rect, height: first },
    { ...rect, y: rect.y + first + gap, height: room - first },
  ];
}

/** The rectangle of every window inside `bounds`, in the same coordinates. */
export function paneRects(layout: Layout, bounds: Rect, gap = GAP): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const place = (node: Layout, rect: Rect) => {
    if (node.kind === "pane") {
      rects.set(node.id, rect);
      return;
    }
    const [first, second] = halves(rect, node.direction, node.ratio, gap);
    place(node.first, first);
    place(node.second, second);
  };
  place(layout, bounds);
  return rects;
}

/** The handle between two halves, with what a drag on it needs to turn a movement into a ratio. */
export interface Divider {
  path: Path;
  direction: Direction;
  /** The gap itself. */
  rect: Rect;
  /** The room the whole split takes, which the ratio is a share of. */
  span: Rect;
}

export function dividers(layout: Layout, bounds: Rect, gap = GAP): Divider[] {
  const found: Divider[] = [];
  const walk = (node: Layout, rect: Rect, path: Path) => {
    if (node.kind === "pane") return;
    const [first, second] = halves(rect, node.direction, node.ratio, gap);
    found.push({
      path,
      direction: node.direction,
      rect:
        node.direction === "row"
          ? { x: first.x + first.width, y: rect.y, width: gap, height: rect.height }
          : { x: rect.x, y: first.y + first.height, width: rect.width, height: gap },
      span: rect,
    });
    walk(node.first, first, [...path, 0]);
    walk(node.second, second, [...path, 1]);
  };
  walk(layout, bounds, []);
  return found;
}

/** The ratio a handle dragged to `point` gives its split. */
export function ratioAt(divider: Divider, point: { x: number; y: number }, gap = GAP): number {
  const { span, direction } = divider;
  const room = Math.max(direction === "row" ? span.width - gap : span.height - gap, 1);
  const offset = direction === "row" ? point.x - span.x : point.y - span.y;
  return clampRatio((offset - gap / 2) / room);
}

export type Heading = "left" | "right" | "up" | "down";

const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/** The window next to `from` in a direction: the nearest that shares some of its edge. */
export function neighbor(
  rects: ReadonlyMap<string, Rect>,
  from: string,
  heading: Heading,
): string | null {
  const origin = rects.get(from);
  if (!origin) return null;
  const horizontal = heading === "left" || heading === "right";
  let best: { id: string; distance: number; shared: number } | null = null;
  for (const [id, rect] of rects) {
    if (id === from) continue;
    const distance =
      heading === "left"
        ? origin.x - (rect.x + rect.width)
        : heading === "right"
          ? rect.x - (origin.x + origin.width)
          : heading === "up"
            ? origin.y - (rect.y + rect.height)
            : rect.y - (origin.y + origin.height);
    if (distance < -1) continue;
    const shared = horizontal
      ? overlap(origin.y, origin.y + origin.height, rect.y, rect.y + rect.height)
      : overlap(origin.x, origin.x + origin.width, rect.x, rect.x + rect.width);
    if (shared <= 0) continue;
    if (
      best === null ||
      distance < best.distance - 1 ||
      (Math.abs(distance - best.distance) <= 1 && shared > best.shared)
    ) {
      best = { id, distance, shared };
    }
  }
  return best?.id ?? null;
}

/** The window under `point` and which part of it the point is in. Null outside every window. */
export function dropZone(
  rects: ReadonlyMap<string, Rect>,
  point: { x: number; y: number },
): { id: string; drop: Drop } | null {
  for (const [id, rect] of rects) {
    const inside =
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height;
    if (!inside) continue;
    const u = (point.x - rect.x) / Math.max(rect.width, 1);
    const v = (point.y - rect.y) / Math.max(rect.height, 1);
    const distances: [Side, number][] = [
      ["left", u],
      ["right", 1 - u],
      ["top", v],
      ["bottom", 1 - v],
    ];
    const [side, nearest] = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
    return { id, drop: nearest >= EDGE_SHARE ? "center" : side };
  }
  return null;
}

/** What a drop would cover: the half of the window on that side, or all of it for the middle. */
export function dropArea(rect: Rect, drop: Drop): Rect {
  switch (drop) {
    case "left":
      return { ...rect, width: rect.width / 2 };
    case "right":
      return { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 };
    case "top":
      return { ...rect, height: rect.height / 2 };
    case "bottom":
      return { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 };
    case "center":
      return rect;
  }
}

/** Where a page is to land: on `drop` of window `target`. */
export interface DropIntent {
  target: string;
  drop: Drop;
}

/**
 * The layout after session `id` becomes the page in front.
 *
 * - With a drop intent the page lands there: beside the target, or in its place for the middle.
 *   A page already in the layout moves rather than appearing twice.
 * - Without one, a page already in the layout is only focused, and any other takes over the
 *   window that was in front (`activeId`), so opening a favorite behaves as it always did.
 * - No layout and no intent stays no layout.
 */
export function place(
  layout: Layout | null,
  activeId: string | null,
  id: string,
  intent: DropIntent | null,
): Layout | null {
  const dropped = intent ? drop(layout, activeId, id, intent) : undefined;
  if (dropped !== undefined) return dropped;
  if (layout === null || contains(layout, id)) return layout;
  const front = activeId !== null && contains(layout, activeId) ? activeId : leaves(layout)[0];
  return replacePane(layout, front, id);
}

/** The layout after a drop, or undefined when the drop names a window that is not there. */
function drop(
  layout: Layout | null,
  activeId: string | null,
  id: string,
  intent: DropIntent,
): Layout | null | undefined {
  const base = layout ?? (activeId ? pane(activeId) : null);
  if (base === null || !contains(base, intent.target)) return undefined;
  if (intent.target === id) return layout;
  const rest = contains(base, id) ? removePane(base, id) : base;
  if (rest === null || !contains(rest, intent.target)) return undefined;
  // A full layout has no room for another window, so the page takes the target's place.
  const replacing = intent.drop === "center" || leaves(rest).length >= MAX_PANES;
  return asLayout(
    replacing
      ? replacePane(rest, intent.target, id)
      : insertPane(rest, intent.target, intent.drop as Side, id),
  );
}

/** The layout as it is saved, each window by the address it was opened with. */
export function toTiles(layout: Layout, urlOf: (id: string) => string | null): Tiles | null {
  if (layout.kind === "pane") {
    const url = urlOf(layout.id);
    return url === null ? null : { kind: "pane", url };
  }
  const first = toTiles(layout.first, urlOf);
  const second = toTiles(layout.second, urlOf);
  if (first === null) return second;
  if (second === null) return first;
  return { kind: "split", direction: layout.direction, ratio: layout.ratio, first, second };
}

/** A saved layout as windows; `idFor` gives each address the session that will show it. */
export function fromTiles(tiles: Tiles, idFor: (url: string, index: number) => string): Layout {
  let index = 0;
  const build = (node: Tiles): Layout =>
    node.kind === "pane"
      ? pane(idFor(node.url, index++))
      : {
          kind: "split",
          direction: node.direction,
          ratio: clampRatio(node.ratio),
          first: build(node.first),
          second: build(node.second),
        };
  return build(tiles);
}

export function tileUrls(tiles: Tiles): string[] {
  return tiles.kind === "pane"
    ? [tiles.url]
    : [...tileUrls(tiles.first), ...tileUrls(tiles.second)];
}

/**
 * The layout once the sessions in `gone` are no longer open, and the window now in front: the one
 * that was, unless it went too, then the window that took its room. A layout left with one window
 * is no layout; that window is then the one in front.
 */
export function withoutSessions(
  layout: Layout | null,
  activeId: string | null,
  gone: readonly string[],
): { layout: Layout | null; activeId: string | null } {
  let rest = layout;
  let front = activeId;
  for (const id of gone) {
    if (rest === null || !contains(rest, id)) continue;
    const successor = successorOf(rest, id);
    rest = removePane(rest, id);
    if (front === id) front = successor;
  }
  const only = rest !== null && leaves(rest).length < 2 ? leaves(rest)[0] : null;
  if (only !== null) {
    front = only;
    rest = null;
  }
  return { layout: rest, activeId: front };
}

/** The unit square topology checks (focus moves, swaps) run on: sizes do not matter, only who is beside whom. */
export const UNIT: Rect = { x: 0, y: 0, width: 1000, height: 1000 };

/** The window beside `from` in a direction, by how the layout is arranged. */
export function neighborOf(layout: Layout, from: string, heading: Heading): string | null {
  return neighbor(paneRects(layout, UNIT, 0), from, heading);
}

/** A balanced tree over `ids` in reading order, alternating side by side and stacked; three make a main window and a stack of two. */
function balanced(ids: readonly string[], depth = 0): Layout {
  if (ids.length === 1) return pane(ids[0]);
  const at = Math.floor(ids.length / 2);
  return split(
    depth % 2 === 0 ? "row" : "column",
    balanced(ids.slice(0, at), depth + 1),
    balanced(ids.slice(at), depth + 1),
  );
}

/** Every window the same size, in one direction. */
function chain(ids: readonly string[], direction: Direction): Layout {
  if (ids.length === 1) return pane(ids[0]);
  return split(direction, pane(ids[0]), chain(ids.slice(1), direction), 1 / ids.length);
}

/** The arrangements the layout can be changed to without changing which pages it holds. */
export type Arrangement = "row" | "column" | "grid";

/** The same windows, in the same order, laid out again. */
export function arrange(layout: Layout, arrangement: Arrangement): Layout {
  const ids = leaves(layout);
  if (ids.length < 2) return layout;
  return arrangement === "grid" ? balanced(ids) : chain(ids, arrangement);
}

/** The split that holds window `id` turns the other way: side by side becomes stacked and back. */
export function flipPane(layout: Layout, id: string): Layout {
  if (layout.kind === "pane") return layout;
  const direct =
    (layout.first.kind === "pane" && layout.first.id === id) ||
    (layout.second.kind === "pane" && layout.second.id === id);
  if (direct) return { ...layout, direction: layout.direction === "row" ? "column" : "row" };
  return contains(layout.first, id)
    ? { ...layout, first: flipPane(layout.first, id) }
    : { ...layout, second: flipPane(layout.second, id) };
}

/** What a folder opens as when it has no layout of its own: up to `MAX_PANES` pages, one window each. */
export function defaultTiles(urls: readonly string[]): Tiles | null {
  const shown = urls.slice(0, MAX_PANES);
  return shown.length < 2 ? null : toTiles(balanced(shown), (id) => id);
}

/** A folder's favorite: its address, which a saved layout names, and the address its window opens. */
export interface Member {
  url: string;
  start: string;
}

/**
 * The windows a folder opens as. The saved layout is kept as far as it still holds: a window
 * whose favorite left the folder goes, and a favorite added since joins on the right. Without a
 * usable layout (none saved, or fewer than two windows left) the default arrangement is used.
 * Each window is by the address its favorite starts at. Null for fewer than two favorites.
 */
export function tilesForFolder(saved: Tiles | null, members: readonly Member[]): Tiles | null {
  const first = new Map<string, Member>();
  for (const member of members) if (!first.has(member.url)) first.set(member.url, member);
  const known = [...first.values()].slice(0, MAX_PANES);
  if (known.length < 2) return null;
  const start = new Map(known.map((member) => [member.url, member.start]));

  let layout: Layout | null = saved ? fromTiles(saved, (url) => url) : null;
  for (const id of layout ? leaves(layout) : []) {
    if (!start.has(id) && layout) layout = removePane(layout, id);
  }
  if (layout === null || leaves(layout).length < 2) return defaultTiles(known.map((m) => m.start));
  for (const member of known) {
    const last = leaves(layout).slice(-1)[0];
    if (!contains(layout, member.url)) layout = insertPane(layout, last, "right", member.url);
  }
  return toTiles(layout, (id) => start.get(id) ?? null);
}
