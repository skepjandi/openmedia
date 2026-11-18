export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  bottom: number;
}

export type Edge = "left" | "right";

export const FAB_SIZE = 64;
/** The button grows by this factor while it charges and while the fan is open. */
export const HOLD_SCALE = 1.3;
export const EDGE_MARGIN = 10;
/**
 * How far from the screen edge the floating button rests: far enough that it grows by `HOLD_SCALE`
 * (ring included, plus 4 px of air) without leaving the screen. Moving it in while it grows left a
 * ghost of its ring behind on Android, so it rests there instead.
 */
export const FAB_REST_MARGIN = Math.ceil((FAB_SIZE / 2) * (HOLD_SCALE - 1)) + 2 + 4;
/** Dropping the button this close to a screen edge, or pushing past it, hides it there. */
export const HIDE_REACH = 14;
/** The hidden button's tab: how far it sticks out of the edge, and how tall it is. */
export const PEEK_WIDTH = 22;
export const PEEK_HEIGHT = 56;
export const FAVORITE_SIZE = 52;
export const SETTINGS_SIZE = 44;
export const HISTORY_SIZE = 44;
export const TABS_SIZE = 44;
export const STATS_SIZE = 44;
export const INCOGNITO_SIZE = 44;
export const CONTROLS_SIZE = 44;
export const DARK_MODE_SIZE = 44;
export const COLOR_PICKER_SIZE = 44;
export const TECH_DETECTOR_SIZE = 44;
export const DOWNLOADS_SIZE = 44;

const SCREEN_PADDING = 6;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
export function separateVerticalPosition(
  y: number,
  blockerY: number,
  minY: number,
  maxY: number,
  clearance: number,
): number {
  if (Math.abs(y - blockerY) >= clearance) return y;
  const candidates = [blockerY - clearance, blockerY + clearance]
    .map((candidate) => clamp(candidate, minY, maxY))
    .filter((candidate) => Math.abs(candidate - blockerY) >= clearance);
  if (candidates.length === 0) return clamp(y, minY, maxY);
  return candidates.reduce((nearest, candidate) =>
    Math.abs(candidate - y) < Math.abs(nearest - y) ? candidate : nearest,
  );
}

/** Resting centre of the button for an edge and a vertical position. */
export function fabCenter(edge: Edge, y: number, viewport: Size, insets: Insets): Point {
  const half = FAB_SIZE / 2;
  return {
    x: edge === "left" ? FAB_REST_MARGIN + half : viewport.width - FAB_REST_MARGIN - half,
    y: clamp(
      y,
      insets.top + FAB_REST_MARGIN + half,
      viewport.height - insets.bottom - FAB_REST_MARGIN - half,
    ),
  };
}

/** Where the button settles when released at `drop`: the nearer edge, clamped on screen. */
export function snapToEdge(drop: Point, viewport: Size, insets: Insets): { edge: Edge; y: number } {
  const edge: Edge = drop.x < viewport.width / 2 ? "left" : "right";
  return { edge, y: fabCenter(edge, drop.y, viewport, insets).y };
}

/** The edge a drop at `drop` pushes the button off, or null when it should settle on screen. */
export function pushedOffEdge(drop: Point, viewport: Size): Edge | null {
  if (drop.x <= HIDE_REACH) return "left";
  if (drop.x >= viewport.width - HIDE_REACH) return "right";
  return null;
}

/** Vertical centre of the hidden button's tab, kept clear of the status bar and home indicator. */
export function peekCenterY(y: number, viewport: Size, insets: Insets): number {
  const half = PEEK_HEIGHT / 2;
  return clamp(
    y,
    insets.top + EDGE_MARGIN + half,
    viewport.height - insets.bottom - EDGE_MARGIN - half,
  );
}

export type FanTarget =
  | { kind: "favorite"; index: number }
  /** An open site that is not one of the favorites. */
  | { kind: "tab"; sessionId: string }
  /** A folder of favorites; a tap opens it. */
  | { kind: "folder"; name: string }
  | { kind: "incognito" }
  | { kind: "stats" }
  | { kind: "history" }
  | { kind: "tabs" }
  | { kind: "controls" }
  | { kind: "darkMode" }
  | { kind: "colorPicker" }
  | { kind: "techDetector" }
  | { kind: "downloads" }
  | { kind: "settings" };

/** Degrees between neighbouring items on the dial. */
export const DIAL_STEP = 30;
/** Distance from the button's centre to the centre of every dial item. */
export const DIAL_RADIUS = 120;
/** Empty arc between two sections, in item steps. */
const SECTION_GAP = 0.5;
/** How far past the visible arc an item keeps fading out, in degrees. */
const DIAL_FADE = DIAL_STEP * 0.7;
/** Items fainter than this cannot be touched. */
export const TOUCHABLE_OPACITY = 0.5;
const TOUCH_SLACK = 10;

/** One stop on the dial. Items of the same `section` sit together; a gap separates sections. */
export interface DialItem {
  target: FanTarget;
  size: number;
  section: number;
}

export interface DialSlot {
  target: FanTarget;
  size: number;
  center: Point;
  /** 1 on the visible arc, fading to 0 as the item turns out of it. */
  opacity: number;
}

/** The arc of the half circle that fits on screen, in degrees from straight out of the edge. */
export interface DialWindow {
  lo: number;
  hi: number;
}

function polar(origin: Point, radius: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  return { x: origin.x + radius * Math.cos(radians), y: origin.y + radius * Math.sin(radians) };
}

/** Where on screen the point `a` degrees round the dial is; negative is above the button. */
function dialPoint(origin: Point, edge: Edge, a: number): Point {
  return polar(origin, DIAL_RADIUS, edge === "left" ? a : 180 - a);
}

/** The part of the half circle where an item fits on screen, widest first around straight out. */
export function dialWindow(origin: Point, edge: Edge, viewport: Size, insets: Insets): DialWindow {
  const reach = FAVORITE_SIZE / 2 + SCREEN_PADDING;
  const fits = (a: number) => {
    const p = dialPoint(origin, edge, a);
    return (
      p.x >= reach &&
      p.x <= viewport.width - reach &&
      p.y >= insets.top + reach &&
      p.y <= viewport.height - insets.bottom - reach
    );
  };
  let lo = 0;
  while (lo > -90 && fits(lo - 1)) lo--;
  let hi = 0;
  while (hi < 90 && fits(hi + 1)) hi++;
  return { lo, hi };
}

/** Each item's place along the dial, in item steps, with a gap where the section changes. */
function dialPositions(items: readonly DialItem[]): number[] {
  let gaps = 0;
  return items.map((item, i) => {
    if (i > 0 && item.section !== items[i - 1].section) gaps++;
    return i + gaps * SECTION_GAP;
  });
}

/** The farthest the dial turns: the last item rests on the end of the visible arc. */
export function dialMaxRotation(items: readonly DialItem[], window: DialWindow): number {
  if (items.length === 0) return 0;
  const positions = dialPositions(items);
  return Math.max(0, positions[positions.length - 1] - (window.hi - window.lo) / DIAL_STEP);
}

export function clampRotation(
  rotation: number,
  items: readonly DialItem[],
  window: DialWindow,
): number {
  return clamp(rotation, 0, dialMaxRotation(items, window));
}

/** The rest position nearest to `rotation`: an item on the first stop, or the dial's far end. */
export function snapRotation(
  rotation: number,
  items: readonly DialItem[],
  window: DialWindow,
): number {
  const max = dialMaxRotation(items, window);
  const target = clamp(rotation, 0, max);
  const stops = [0, max, ...dialPositions(items).filter((p) => p <= max)];
  return stops.reduce((best, stop) =>
    Math.abs(stop - target) < Math.abs(best - target) ? stop : best,
  );
}

/**
 * How far the dial turns, in item steps, when a finger moves from `from` to `to` round the
 * button: the items follow the finger.
 */
export function dialTurn(origin: Point, edge: Edge, from: Point, to: Point): number {
  const before = Math.atan2(from.y - origin.y, from.x - origin.x);
  const after = Math.atan2(to.y - origin.y, to.x - origin.x);
  let degrees = ((after - before) * 180) / Math.PI;
  while (degrees > 180) degrees -= 360;
  while (degrees <= -180) degrees += 360;
  return (-degrees * (edge === "left" ? 1 : -1)) / DIAL_STEP;
}

/**
 * Items on a half circle round the button, opening away from the edge. `rotation` (in item
 * steps) is how far the dial has turned: 0 puts the first item at the top of the visible arc.
 * Items turned out of the arc fade away.
 */
export function dialSlots(
  origin: Point,
  edge: Edge,
  viewport: Size,
  insets: Insets,
  items: readonly DialItem[],
  rotation: number,
): DialSlot[] {
  const window = dialWindow(origin, edge, viewport, insets);
  const positions = dialPositions(items);
  return items.map((item, i) => {
    const a = window.lo + (positions[i] - rotation) * DIAL_STEP;
    const outside = a < window.lo ? window.lo - a : a > window.hi ? a - window.hi : 0;
    return {
      target: item.target,
      size: item.size,
      center: dialPoint(
        origin,
        edge,
        clamp(a, Math.max(-90, window.lo - DIAL_FADE), Math.min(90, window.hi + DIAL_FADE)),
      ),
      opacity: clamp(1 - outside / DIAL_FADE, 0, 1),
    };
  });
}

/** The dial item under a finger, with a little slack so a thumb can slide onto it. */
export function dialTargetAt(point: Point, slots: readonly DialSlot[]): FanTarget | null {
  const hit = slots.find(
    ({ center, size, opacity }) =>
      opacity >= TOUCHABLE_OPACITY &&
      Math.hypot(point.x - center.x, point.y - center.y) <= size / 2 + TOUCH_SLACK,
  );
  return hit?.target ?? null;
}
