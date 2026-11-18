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

/**
 * How far above and below straight out of the edge the favorites ring reaches. The rest of the
 * half circle is left to the two columns of buttons that run straight up and down from the button.
 */
export const RING_HALF_SPAN = 60;
/** Degrees between neighbouring items on the dial. */
export const DIAL_STEP = 30;
/** Distance from the button's centre to the centre of every dial item. */
export const DIAL_RADIUS = 120;
/** Empty arc between two sections, in item steps. */
const SECTION_GAP = 0.5;
/** How far past the visible arc an item keeps fading out, in degrees. */
const DIAL_FADE = DIAL_STEP * 0.5;
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

/** The part of the ring where an item fits on screen, widest first around straight out. */
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
  while (lo > -RING_HALF_SPAN && fits(lo - 1)) lo--;
  let hi = 0;
  while (hi < RING_HALF_SPAN && fits(hi + 1)) hi++;
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
      center: dialPoint(origin, edge, clamp(a, window.lo - DIAL_FADE, window.hi + DIAL_FADE)),
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

/** Distance between neighbouring buttons on the line. */
export const TOOL_STEP = 52;
/** From the button's centre to the first button above it, clear of the ring. */
const TOOL_START = 132;
/** The nearest a button on the line sits to the open button without fading. */
const TOOL_START_NEAR = 75;
/** A button this far past a place where it hides has faded out completely. */
const TOOL_FADE = TOOL_STEP * 0.6;
const TOOL_REACH = TOOL_STEP / 2 + SCREEN_PADDING;

/** A button on the line. */
export interface ToolItem {
  target: FanTarget;
  size: number;
}

/**
 * Where the two groups of tool buttons start. They share one vertical line through the open
 * button: the page buttons (usage, tabs, history, settings) go on the side with more room, the
 * switches (incognito, video controls, dark mode, ...) on the other.
 */
export interface ToolPlan {
  /** True when the page buttons are below the button and the switches above it. */
  pageBelow: boolean;
  /** Distance from the centre to the nearest button above and the nearest below. */
  topStart: number;
  bottomStart: number;
}

export function toolPlan(origin: Point, viewport: Size, insets: Insets): ToolPlan {
  const pageBelow = viewport.height - insets.bottom - origin.y >= origin.y - insets.top;
  return {
    pageBelow,
    // Below, the page column's nearest button (usage) sits just clear of the button.
    topStart: TOOL_START,
    bottomStart: pageBelow ? TOOL_START_NEAR : TOOL_START,
  };
}

/** The line's limits relative to the button's centre: up is negative. */
function toolLimits(origin: Point, viewport: Size, insets: Insets) {
  return {
    top: -(origin.y - insets.top - TOOL_REACH),
    bottom: viewport.height - insets.bottom - TOOL_REACH - origin.y,
  };
}

/** Each button's resting place on the line, top to bottom: `topCount` above the button, the rest below. */
function toolRest(count: number, topCount: number, plan: ToolPlan): number[] {
  return Array.from({ length: count }, (_, i) =>
    i < topCount
      ? -(plan.topStart + (topCount - 1 - i) * TOOL_STEP)
      : plan.bottomStart + (i - topCount) * TOOL_STEP,
  );
}

/**
 * How far the line slides, in button steps (down is positive): from the last button reaching the
 * top of the screen to the first reaching the bottom. Always includes 0.
 */
export function toolScrollRange(
  origin: Point,
  viewport: Size,
  insets: Insets,
  count: number,
  topCount: number,
  plan: ToolPlan,
): { min: number; max: number } {
  const rest = toolRest(count, topCount, plan);
  if (rest.length === 0) return { min: 0, max: 0 };
  const limits = toolLimits(origin, viewport, insets);
  return {
    min: Math.min(0, Math.ceil((limits.top - rest[rest.length - 1]) / TOOL_STEP)),
    max: Math.max(0, Math.floor((limits.bottom - rest[0]) / TOOL_STEP)),
  };
}

/** The rest position nearest to `scroll`: a whole number of buttons, within range. */
export function snapToolScroll(scroll: number, range: { min: number; max: number }): number {
  return Math.round(clamp(scroll, range.min, range.max));
}

/**
 * The tool buttons on their line, top to bottom: the first `topCount` start above the open
 * button, the rest below it. `scroll` slides all of them along the line, in button steps: 0 is
 * where they start. A button hides while it is near the open button, and as it nears the top or
 * bottom of the screen, so one slid past the open button comes out on its other side.
 */
export function toolSlots(
  origin: Point,
  viewport: Size,
  insets: Insets,
  items: readonly ToolItem[],
  topCount: number,
  plan: ToolPlan,
  scroll: number,
): DialSlot[] {
  const limits = toolLimits(origin, viewport, insets);
  const rest = toolRest(items.length, topCount, plan);
  return items.map((item, i) => {
    const u = rest[i] + scroll * TOOL_STEP;
    const nearButton = clamp((Math.abs(u) - (TOOL_START_NEAR - TOOL_FADE)) / TOOL_FADE, 0, 1);
    const pastEdge = u < limits.top ? limits.top - u : u > limits.bottom ? u - limits.bottom : 0;
    return {
      target: item.target,
      size: item.size,
      center: {
        x: origin.x,
        y: origin.y + clamp(u, limits.top - TOOL_FADE, limits.bottom + TOOL_FADE),
      },
      opacity: Math.min(nearButton, clamp(1 - pastEdge / TOOL_FADE, 0, 1)),
    };
  });
}
