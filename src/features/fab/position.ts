import type { Edge } from "./geometry";

const KEY = "om.fab";
const POSITION_EVENT = "om:fab-position";

export interface FabPosition {
  edge: Edge;
  /** Vertical centre as a fraction of the viewport height, so rotation keeps its place. */
  yRatio: number;
  /** Pushed off the edge: only a small tab stays, to bring the button back. */
  hidden: boolean;
}

const fallback: FabPosition = { edge: "right", yRatio: 0.62, hidden: false };

export function loadPosition(): FabPosition {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && typeof value === "object" && "edge" in value && "yRatio" in value) {
      const { edge, yRatio } = value;
      if ((edge === "left" || edge === "right") && typeof yRatio === "number") {
        return {
          edge,
          yRatio: Math.min(Math.max(yRatio, 0), 1),
          hidden: "hidden" in value && value.hidden === true,
        };
      }
    }
  } catch {
    // an unreadable preference falls back to the default position
  }
  return fallback;
}

let currentPosition: FabPosition | undefined;

export function getPosition() {
  return (currentPosition ??= loadPosition());
}

export function subscribePosition(listener: () => void) {
  window.addEventListener(POSITION_EVENT, listener);
  return () => window.removeEventListener(POSITION_EVENT, listener);
}

export function savePosition(position: FabPosition) {
  localStorage.setItem(KEY, JSON.stringify(position));
  currentPosition = position;
  window.dispatchEvent(new Event(POSITION_EVENT));
}
