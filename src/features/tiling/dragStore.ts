import { create } from "zustand";
import { useApp, type DroppedPage } from "../../app/store";
import type { Rect } from "../../shared/ipc";
import { dropArea, dropZone, type Drop } from "./layout";

interface Point {
  x: number;
  y: number;
}

/** A page being carried over the window: what it is, how to show it, and where the pointer is. */
export interface TileDrag {
  page: DroppedPage;
  label: string;
  icon?: string;
  point: Point;
}

interface DragStore {
  drag: TileDrag | null;
}

/** The page being dragged onto the windows, if any. */
export const useTileDrag = create<DragStore>(() => ({ drag: null }));

/** What a drop can land on, in window coordinates: the page area and each window in it. */
export interface DropMap {
  page: Rect;
  /** The windows by session; null while no page is open, when the whole area is one empty window. */
  windows: ReadonlyMap<string, Rect> | null;
}

/** Where a drop at a point would land and what it would cover. */
export interface DropTarget {
  /** The window it lands on; null on an empty page. */
  target: string | null;
  drop: Drop;
  area: Rect;
}

const within = (rect: Rect, point: Point): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height;

const distanceTo = (rect: Rect, point: Point): number =>
  Math.hypot(
    Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width)),
    Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height)),
  );

/** The window under `point` (the nearest one when the point is in a gap), or null off the page. */
export function resolveDrop(map: DropMap, point: Point): DropTarget | null {
  if (!within(map.page, point)) return null;
  if (map.windows === null) return { target: null, drop: "center", area: map.page };
  const zone = dropZone(map.windows, point);
  if (zone) {
    const rect = map.windows.get(zone.id);
    return rect ? { target: zone.id, drop: zone.drop, area: dropArea(rect, zone.drop) } : null;
  }
  let nearest: [string, Rect] | null = null;
  for (const entry of map.windows) {
    if (nearest === null || distanceTo(entry[1], point) < distanceTo(nearest[1], point)) {
      nearest = entry;
    }
  }
  return nearest ? { target: nearest[0], drop: "center", area: nearest[1] } : null;
}

let readMap: (() => DropMap | null) | null = null;

/** The layer that knows where the windows are says so, so a drop can be placed from anywhere. */
export function registerDropMap(read: (() => DropMap | null) | null) {
  readMap = read;
}

/**
 * Where a drop at `point` would land. A folder opens in a layout of its own, so it covers the
 * whole page area whichever window the pointer is over.
 */
export const currentDropTarget = (point: Point): DropTarget | null => {
  const map = readMap?.() ?? null;
  if (map && useTileDrag.getState().drag?.page.kind === "folder") {
    return within(map.page, point) ? { target: null, drop: "center", area: map.page } : null;
  }
  return map ? resolveDrop(map, point) : null;
};

/** How long after a drop the click it would otherwise become is still thrown away. */
const CLICK_WINDOW_MS = 80;

/**
 * Starts carrying a page from where the pointer went down. The pointer is taken over by the
 * document so the carry goes on whichever button the press began on; the page is dropped where
 * the pointer is let go, and Escape drops nothing. The press that began the carry would otherwise
 * end as a click on the button it began on, which is thrown away.
 */
export function beginTileDrag(
  pointer: { pointerId: number; clientX: number; clientY: number },
  page: DroppedPage,
  label: string,
  icon?: string,
) {
  if (useTileDrag.getState().drag) return;
  useTileDrag.setState({
    drag: { page, label, icon, point: { x: pointer.clientX, y: pointer.clientY } },
  });
  try {
    document.documentElement.setPointerCapture(pointer.pointerId);
  } catch {
    // capture is best-effort: the pointer may already be gone
  }

  const stop = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    useTileDrag.setState({ drag: null });
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", swallow, true);
    window.setTimeout(() => window.removeEventListener("click", swallow, true), CLICK_WINDOW_MS);
  };
  const onMove = (event: PointerEvent) => {
    const current = useTileDrag.getState().drag;
    if (current) {
      useTileDrag.setState({
        drag: { ...current, point: { x: event.clientX, y: event.clientY } },
      });
    }
  };
  const onUp = (event: PointerEvent) => {
    const landing = currentDropTarget({ x: event.clientX, y: event.clientY });
    stop();
    if (landing) useApp.getState().dropPage(page, landing.target, landing.drop);
  };
  const onCancel = () => stop();
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
}
