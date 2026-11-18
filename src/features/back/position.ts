import type { Edge } from "../fab/geometry";

const KEY = "om.back";

export interface BackPosition {
  edge: Edge;
  /** Vertical centre as a fraction of the viewport height, so rotation keeps its place. */
  yRatio: number;
  /** Pushed off the edge: only a small tab stays, to bring the button back. */
  hidden: boolean;
}

const fallback: BackPosition = { edge: "left", yRatio: 0.9, hidden: true };

export function loadBackPosition(): BackPosition {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && typeof value === "object" && "edge" in value && "yRatio" in value) {
      const { edge, yRatio } = value;
      if ((edge === "left" || edge === "right") && typeof yRatio === "number") {
        return {
          edge,
          yRatio: Math.min(Math.max(yRatio, 0), 1),
          hidden: !("hidden" in value) || value.hidden !== false,
        };
      }
    }
  } catch {
    // an unreadable preference falls back to the default position
  }
  return fallback;
}

export function saveBackPosition(position: BackPosition) {
  localStorage.setItem(KEY, JSON.stringify(position));
}
