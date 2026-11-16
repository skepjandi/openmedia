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
/** How far the lock or incognito badge hangs past the button's edge before scaling. */
const BADGE_OVERHANG = 4;
/** Distance from the button's centre to the far edge of its badge while the fan is open. */
const FAB_OPEN_REACH = (FAB_SIZE / 2 + BADGE_OVERHANG) * HOLD_SCALE;
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
/** Centre-to-centre distance between neighbouring buttons in the settings column. */
const COLUMN_OFFSET = 52;
/** From the settings button up to the incognito button at the top of the column. */
const COLUMN_REACH = 4 * COLUMN_OFFSET;

const MIN_FAN_RADIUS = 108;
const MAX_ARC_DEGREES = 120;
const MAX_STEP_DEGREES = 30;
const SETTINGS_DISTANCE = 132;
const ITEM_GAP = 6;
/** Centre-to-centre distance that keeps the column's top button clear of the open button. */
const COLUMN_CLEARANCE = FAB_OPEN_REACH + INCOGNITO_SIZE / 2 + ITEM_GAP;
const SCREEN_PADDING = 6;
/** Absorbs rounding when an item is placed exactly at its minimum distance. */
const FLOAT_SLACK = 1e-6;
const ARC_SCALES = [1, 0.8, 0.65, 0.5, 0.35];
const SHIFTS = [0, ...Array.from({ length: 16 }, (_, i) => [(i + 1) * 5, -(i + 1) * 5]).flat()];

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

export interface FanLayout {
  favorites: Point[];
  settings: Point;
  history: Point;
  tabs: Point;
  stats: Point;
  incognito: Point;
}

export type FanTarget =
  | { kind: "favorite"; index: number }
  | { kind: "incognito" }
  | { kind: "stats" }
  | { kind: "history" }
  | { kind: "tabs" }
  | { kind: "settings" };

interface FanItem {
  center: Point;
  size: number;
}

function polar(origin: Point, radius: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  return { x: origin.x + radius * Math.cos(radians), y: origin.y + radius * Math.sin(radians) };
}

/** Big enough that neighbouring favorites on the arc never touch. */
function radiusFor(stepDegrees: number) {
  if (stepDegrees === 0) return MIN_FAN_RADIUS;
  const chordNeeded = FAVORITE_SIZE + ITEM_GAP;
  return Math.max(MIN_FAN_RADIUS, chordNeeded / (2 * Math.sin((stepDegrees * Math.PI) / 360)));
}

function isValid(items: FanItem[], origin: Point, viewport: Size, insets: Insets) {
  const onScreen = items.every(({ center, size }) => {
    const reach = size / 2 + SCREEN_PADDING;
    return (
      center.x >= reach &&
      center.x <= viewport.width - reach &&
      center.y >= insets.top + reach &&
      center.y <= viewport.height - insets.bottom - reach
    );
  });
  const clearOfButton = items.every(
    ({ center, size }) =>
      Math.hypot(center.x - origin.x, center.y - origin.y) + FLOAT_SLACK >=
      FAB_OPEN_REACH + size / 2 + ITEM_GAP,
  );
  const apart = items.every((a, i) =>
    items.slice(i + 1).every((b) => {
      const gap = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
      return gap >= (a.size + b.size) / 2 + ITEM_GAP / 2;
    }),
  );
  return onScreen && clearOfButton && apart;
}

/**
 * Favorites sit on an arc opening away from the edge, listed top to bottom. Settings is tucked
 * on the edge column above or below the button, farther out than the arc, so it never reads as
 * a favorite. History sits directly above it in the same column, tabs directly above that, then
 * usage, and incognito at the top. Below the button the whole column is pushed out far enough that its top
 * item clears the button. When the button is near the top or bottom the arc rotates, the column
 * may flip sides, and finally the arc compacts (smaller steps, larger radius) until everything
 * fits.
 */
export function fanLayout(
  origin: Point,
  edge: Edge,
  viewport: Size,
  insets: Insets,
  favoriteCount: number,
): FanLayout {
  const inward = edge === "left" ? 0 : 180;
  const direction = edge === "left" ? 1 : -1;
  const nominalStep =
    favoriteCount > 1 ? Math.min(MAX_STEP_DEGREES, MAX_ARC_DEGREES / (favoriteCount - 1)) : 0;
  const roomBelow = viewport.height - insets.bottom - origin.y;
  const roomAbove = origin.y - insets.top;
  const preferred = roomBelow >= roomAbove ? 1 : -1;

  const place = (scale: number, shift: number, side: number): FanLayout => {
    const step = nominalStep * scale;
    const radius = radiusFor(step);
    const distance = Math.max(SETTINGS_DISTANCE, radius + 30);
    const settings = {
      x: origin.x,
      y: origin.y + (side > 0 ? Math.max(distance, COLUMN_REACH + COLUMN_CLEARANCE) : -distance),
    };
    return {
      favorites: Array.from({ length: favoriteCount }, (_, i) =>
        polar(origin, radius, inward + direction * (shift + (i - (favoriteCount - 1) / 2) * step)),
      ),
      settings,
      history: { x: settings.x, y: settings.y - COLUMN_OFFSET },
      tabs: { x: settings.x, y: settings.y - 2 * COLUMN_OFFSET },
      stats: { x: settings.x, y: settings.y - 3 * COLUMN_OFFSET },
      incognito: { x: settings.x, y: settings.y - 4 * COLUMN_OFFSET },
    };
  };
  const items = (layout: FanLayout): FanItem[] => [
    ...layout.favorites.map((center) => ({ center, size: FAVORITE_SIZE })),
    { center: layout.settings, size: SETTINGS_SIZE },
    { center: layout.history, size: HISTORY_SIZE },
    { center: layout.tabs, size: TABS_SIZE },
    { center: layout.stats, size: STATS_SIZE },
    { center: layout.incognito, size: INCOGNITO_SIZE },
  ];

  for (const scale of favoriteCount > 1 ? ARC_SCALES : [1]) {
    for (const shift of SHIFTS) {
      for (const side of [preferred, -preferred]) {
        const layout = place(scale, shift, side);
        if (isValid(items(layout), origin, viewport, insets)) return layout;
      }
    }
  }
  return place(1, 0, preferred);
}

const TOUCH_SLACK = 10;

/** The fan item under a finger, with a little slack so a thumb can slide onto it. */
export function fanTargetAt(point: Point, layout: FanLayout): FanTarget | null {
  const near = (center: Point, size: number) =>
    Math.hypot(point.x - center.x, point.y - center.y) <= size / 2 + TOUCH_SLACK;
  const index = layout.favorites.findIndex((p) => near(p, FAVORITE_SIZE));
  if (index >= 0) return { kind: "favorite", index };
  if (near(layout.incognito, INCOGNITO_SIZE)) return { kind: "incognito" };
  if (near(layout.stats, STATS_SIZE)) return { kind: "stats" };
  if (near(layout.tabs, TABS_SIZE)) return { kind: "tabs" };
  if (near(layout.history, HISTORY_SIZE)) return { kind: "history" };
  return near(layout.settings, SETTINGS_SIZE) ? { kind: "settings" } : null;
}
