/** Distance a two-finger swipe must travel, in wheel pixels, to count as Back. */
export const SWIPE_DISTANCE = 140;
/** Wheel events further apart than this belong to different swipes. */
const SWIPE_GAP_MS = 180;
/** After a swipe fires, its inertia keeps sending wheel events; they are ignored until this much quiet. */
const INERTIA_QUIET_MS = 450;
/** A swipe must be this much more horizontal than vertical, or it is a scroll. */
const HORIZONTAL_BIAS = 2;

export interface WheelSwipe {
  /** Distance travelled toward Back in the current swipe; never negative. */
  travelled: number;
  lastAt: number;
  fired: boolean;
}

export const idleSwipe: WheelSwipe = {
  travelled: 0,
  lastAt: Number.NEGATIVE_INFINITY,
  fired: false,
};

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  at: number;
  /** Right-to-left pages go Back with a swipe the other way. */
  rtl: boolean;
}

/**
 * A two-finger trackpad swipe toward the reading side, as wheel events: the Back gesture on the
 * app's own pages (the web view handles its own). Swiping right moves the content right, which is
 * a negative `deltaX` with natural scrolling, the default.
 */
export function reduceWheel(
  state: WheelSwipe,
  input: WheelInput,
): { state: WheelSwipe; back: boolean } {
  const quiet = input.at - state.lastAt;
  if (state.fired) {
    const next = { ...state, lastAt: input.at };
    return quiet > INERTIA_QUIET_MS ? reduceWheel(idleSwipe, input) : { state: next, back: false };
  }
  const base = quiet > SWIPE_GAP_MS ? idleSwipe : state;
  const horizontal = Math.abs(input.deltaX) > Math.abs(input.deltaY) * HORIZONTAL_BIAS;
  if (!horizontal) return { state: { travelled: 0, lastAt: input.at, fired: false }, back: false };
  const toward = input.rtl ? input.deltaX : -input.deltaX;
  const travelled = Math.max(0, base.travelled + toward);
  if (travelled >= SWIPE_DISTANCE)
    return { state: { travelled: 0, lastAt: input.at, fired: true }, back: true };
  return { state: { travelled, lastAt: input.at, fired: false }, back: false };
}
