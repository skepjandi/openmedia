export type Side = "left" | "right";

export interface TouchPoint {
  x: number;
  y: number;
}

/** A swipe that begins this close to the screen edge counts as the back gesture. */
export const EDGE_ZONE = 24;
/** The page starts following the finger once it has travelled this far inward. */
export const LOCK_DISTANCE = 10;
/** Letting go before this far inward always springs the page back. */
export const SWIPE_DISTANCE = 72;
/** Letting go past this share of the screen width closes the page. */
const COMMIT_SHARE = 0.4;
/** A flick at least this fast (pixels per millisecond) closes the page from a shorter drag. */
const FLING_VELOCITY = 0.5;
/** The travel must be this much more sideways than vertical, so a scroll is not taken for it. */
const HORIZONTAL_BIAS = 1.5;

/** The edge a back swipe starts from: where reading starts, so the right edge in right-to-left. */
export const backSide = (dir: string): Side => (dir === "rtl" ? "right" : "left");

export function startsAtEdge(x: number, width: number, side: Side): boolean {
  return side === "left" ? x <= EDGE_ZONE : x >= width - EDGE_ZONE;
}

/** How far the finger has moved away from the starting edge; negative when it moved toward it. */
export const inwardTravel = (start: TouchPoint, now: TouchPoint, side: Side): number =>
  side === "left" ? now.x - start.x : start.x - now.x;

/** Whether the touch is a deliberate sideways drag away from the edge, not a scroll. */
export function isBackDrag(start: TouchPoint, now: TouchPoint, side: Side): boolean {
  const inward = inwardTravel(start, now, side);
  return inward >= LOCK_DISTANCE && inward >= Math.abs(now.y - start.y) * HORIZONTAL_BIAS;
}

/** Whether letting go at `offset` pixels (moving at `velocity` px/ms) closes the page. */
export function commitsBack(offset: number, velocity: number, width: number): boolean {
  if (offset < SWIPE_DISTANCE) return false;
  return offset >= width * COMMIT_SHARE || velocity >= FLING_VELOCITY;
}
