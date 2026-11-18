import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import {
  selectPage,
  selectQuickFavorites,
  selectQuickFolders,
  useApp,
  type DroppedPage,
} from "../../app/store";
import { unreadByFavorite } from "../web/unreadWatch";
import { sessionForFavorite, type Session } from "../web/sessions";
import { FolderPopup, type FolderMember } from "./FolderPopup";
import { orderedTabs } from "../tabs/tabs";
import { useT } from "../../i18n/useT";
import {
  FREE_QUICK_ACCESS_LIMIT,
  displayHost,
  folderIcon,
  folderKey,
  groupByFolder,
  quickSlots,
  usableQuickAccess,
} from "../../shared/favorites";
import type { Favorite } from "../../shared/ipc";
import { DARK_MODE_DEFAULT, darkActiveFor } from "../../shared/darkMode";
import { siteOf } from "../../shared/site";
import { iconForUrl, useIconCache } from "../../shared/siteIcons";
import { VIDEO_CONTROLS_DEFAULT } from "../../shared/videoControls";
import { useInsets, useViewport } from "../../shared/viewport";
import {
  FAB_SIZE,
  DIAL_RADIUS,
  FAVORITE_SIZE,
  HISTORY_SIZE,
  HOLD_SCALE,
  COLOR_PICKER_SIZE,
  DOWNLOADS_SIZE,
  CONTROLS_SIZE,
  DARK_MODE_SIZE,
  INCOGNITO_SIZE,
  PEEK_HEIGHT,
  PEEK_WIDTH,
  SETTINGS_SIZE,
  STATS_SIZE,
  TABS_SIZE,
  TECH_DETECTOR_SIZE,
  TOOL_STEP,
  TOUCHABLE_OPACITY,
  clampRotation,
  dialSlots,
  dialTargetAt,
  dialTurn,
  dialWindow,
  fabCenter,
  peekCenterY,
  pushedOffEdge,
  snapRotation,
  snapToolScroll,
  snapToEdge,
  toolScrollRange,
  toolPlan,
  toolSlots,
  type DialItem,
  type DialSlot,
  type Edge,
  type FanTarget,
  type Point,
} from "./geometry";
import {
  DRAG_SLOP,
  HOLD_MS,
  reduceGesture,
  type GestureEffect,
  type GestureEvent,
  type GestureState,
} from "./gesture";
import { loadPosition, savePosition, type FabPosition } from "./position";
import { BiometricIcon } from "../incognito/BiometricIcon";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ColorPickerIcon,
  DownloadIcon,
  TechIcon,
  HistoryIcon,
  IncognitoIcon,
  MoonIcon,
  ProIcon,
  SlidersIcon,
  StatsIcon,
  TabsIcon,
  TilesIcon,
  VideoControlsIcon,
} from "../../shared/icons";
import { useBackHandler } from "../back/useBackHandler";
import logoMark from "../../assets/logo-mark.svg";
import { useEntitlementStore } from "../paywall/store";
import { useDownloadsStore } from "../downloads/store";
import { setVideoPanel } from "../settings/videoPanel";
import { selectFabHidden, useKeybindings } from "../keybindings/store";
import type { Workspace } from "../../shared/ipc";
import { beginTileDrag } from "../tiling/dragStore";

const NO_WORKSPACES: readonly Workspace[] = [];

const idle: GestureState = { phase: "idle" };

const monogram = (name: string) => name.trim().charAt(0).toUpperCase() || "·";

/** Closer to the button than this, a finger's angle round it is too jumpy to turn the dial with. */
const MIN_TURN_RADIUS = 40;
/** Minimum time between wheel notches, so a trackpad flick turns the dial a stop or two. */
const WHEEL_GAP_MS = 120;

/** The ring's sections, in the order they appear going round it. */
const QUICK = 0;
const OPEN = 1;
const REST = 2;
/** A finger this near the line of a column (sideways, in px) turns that column, not the ring. */
const COLUMN_BAND = 30;

/** What a finger turns: the ring of favorites, or the line of tool buttons. */
type Lane = "ring" | "tools";

function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -end-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full border-2 border-ink bg-accent px-1 text-[10px] leading-none font-semibold text-white"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** A site that is running, as a dock shows it: a small dot under its icon. */
function OpenDot() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-1.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_4px_rgb(0_0_0/0.6)]"
    />
  );
}

interface FanStyle extends CSSProperties {
  "--x": string;
  "--y": string;
  "--cx": string;
  "--cy": string;
  "--o": number;
  "--i": number;
  "--n": number;
}

/** What the dial lists for favorites: one on its own, or a folder standing for several. */
type FavoriteItem =
  | { kind: "slot"; index: number; live: boolean }
  | {
      kind: "folder";
      name: string;
      members: { favorite: Favorite; index: number }[];
      live: boolean;
    };

/** A button that is shown on the dial, whatever it does. */
interface Entry {
  /** Where it sits: on the ring of favorites, or in one of the two columns. */
  lane: Lane;
  target: FanTarget;
  size: number;
  section: number;
  label: string;
  content: ReactNode;
  /** Text beside the button, on the side away from the screen edge. */
  caption?: string;
  /** The button is a switch that is on; it turns solid. */
  active?: boolean;
  pressed?: boolean;
  busy?: boolean;
  /** Ring-style highlight on hover (sites) rather than an accent border (tools). */
  site?: boolean;
  className?: string;
  /** Press and hold does something else; the ring shows it charging. Null for a plain button. */
  charging?: boolean;
}

/** What dragging a button out of the dial carries to the page. */
interface Carry {
  page: DroppedPage;
  label: string;
  icon?: string;
}

/** How far a press on a button moves before it can be a drag out of the dial. */
const CARRY_SLOP = 20;
/** The most a movement may stray from straight out of the dial and still be a drag out. */
const CARRY_COSINE = 0.5;

/**
 * Whether a finger that went down at `from` is now heading away from the dial's center, rather
 * than round it (which turns the dial) or back in.
 */
function headsOutward(from: Point, to: Point, center: Point, origin: Point): boolean {
  const moved = { x: to.x - from.x, y: to.y - from.y };
  const away = { x: center.x - origin.x, y: center.y - origin.y };
  const length = Math.hypot(moved.x, moved.y) * Math.hypot(away.x, away.y);
  if (Math.hypot(moved.x, moved.y) <= CARRY_SLOP || length === 0) return false;
  return (moved.x * away.x + moved.y * away.y) / length >= CARRY_COSINE;
}

const targetKey = (target: FanTarget) =>
  target.kind === "favorite"
    ? `favorite:${target.index}`
    : target.kind === "tab"
      ? `tab:${target.sessionId}`
      : target.kind === "workspace"
        ? `workspace:${target.id}`
        : target.kind === "folder"
          ? `folder:${folderKey(target.name) ?? target.name}`
          : target.kind;

const sameTarget = (a: FanTarget | null, b: FanTarget) =>
  a !== null && targetKey(a) === targetKey(b);

interface Hold {
  start: () => void;
  stop: () => void;
  /** True once the hold has fired; the click that follows the lift is then swallowed. */
  consumeHeld: () => boolean;
}

interface DialButtonProps {
  entry: Entry;
  slot: DialSlot;
  index: number;
  count: number;
  /** Where the floating button is: closed, every item sits on it. */
  origin: Point;
  edge: Edge;
  fanOpen: boolean;
  hovered: boolean;
  turn: "drag" | "snap" | null;
  holdOf: (kind: FanTarget["kind"]) => Hold | null;
  onSpinStart: (event: PointerEvent<HTMLElement>, lane: Lane) => void;
  onSpinMove: (event: PointerEvent<HTMLElement>) => void;
  onSpinEnd: () => boolean;
  onWheel: (event: WheelEvent) => void;
  onActivate: (target: FanTarget, hold: Hold | null) => void;
  /** What a drag out of this button carries; null for a button that cannot be dragged. */
  carry: Carry | null;
  onCarry: (event: PointerEvent<HTMLElement>, carry: Carry) => void;
}

/** One button on the dial. It sits at its stop, follows a finger turning the dial, and fades out of the arc. */
function DialButton({
  entry,
  slot,
  index,
  count,
  origin,
  edge,
  fanOpen,
  hovered,
  turn,
  holdOf,
  onSpinStart,
  onSpinMove,
  onSpinEnd,
  onWheel,
  onActivate,
  carry,
  onCarry,
}: DialButtonProps) {
  const hold = holdOf(entry.target.kind);
  const press = useRef<Point | null>(null);
  const style: FanStyle = {
    "--x": `${slot.center.x}px`,
    "--y": `${slot.center.y}px`,
    "--cx": `${origin.x}px`,
    "--cy": `${origin.y}px`,
    "--o": slot.opacity,
    "--i": Math.min(index, 8),
    "--n": Math.min(count, 9),
    width: entry.size,
    height: entry.size,
    margin: -entry.size / 2,
    touchAction: "none",
  };
  return (
    <button
      type="button"
      data-open={fanOpen}
      data-faded={slot.opacity < TOUCHABLE_OPACITY}
      data-turn={turn ?? undefined}
      data-active={entry.active}
      data-hold={hold ? (entry.charging ? "charging" : "idle") : undefined}
      aria-label={entry.label}
      aria-pressed={entry.pressed}
      aria-busy={entry.busy}
      disabled={entry.busy}
      tabIndex={fanOpen && slot.opacity >= TOUCHABLE_OPACITY ? 0 : -1}
      onPointerDown={(event) => {
        press.current = { x: event.clientX, y: event.clientY };
        onSpinStart(event, entry.lane);
        hold?.start();
      }}
      onPointerMove={(event) => {
        const from = press.current;
        if (
          carry &&
          from &&
          headsOutward(from, { x: event.clientX, y: event.clientY }, slot.center, origin)
        ) {
          press.current = null;
          onCarry(event, carry);
          return;
        }
        onSpinMove(event);
      }}
      onPointerUp={() => {
        hold?.stop();
        onSpinEnd();
      }}
      onPointerLeave={hold?.stop}
      onPointerCancel={() => {
        hold?.stop();
        onSpinEnd();
      }}
      onWheel={onWheel}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => onActivate(entry.target, hold)}
      style={style}
      className={`fan-item fab-glass fixed z-20 grid place-items-center rounded-full ${
        hovered ? (entry.site ? "ring-2 ring-accent" : "border-accent!") : ""
      } ${hovered && !entry.site && !entry.active ? "text-accent" : ""} ${entry.className ?? "text-white"}`}
    >
      {entry.content}
      {entry.caption && (
        <span
          className={`pointer-events-none absolute top-1/2 max-w-[38vw] -translate-y-1/2 truncate text-[11px] font-medium tracking-[0.14em] whitespace-nowrap text-white uppercase [text-shadow:0_1px_6px_rgb(0_0_0/0.7)] ${
            edge === "left"
              ? "left-full ml-3 text-start rtl:text-end"
              : "right-full mr-3 text-end rtl:text-start"
          }`}
        >
          {entry.caption}
        </span>
      )}
      {hold && (
        <svg className="fab-ring" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="31" pathLength="1" />
        </svg>
      )}
    </button>
  );
}

/**
 * The floating button. Tap: assistant. Drag: move, then snap to the nearer edge. Hold: open the
 * dial, a half circle of buttons round it: quick access first, then the sites that are open
 * (favorites and other tabs), then the favorites that are not. Slide onto one and lift, or lift
 * and tap. Turn the dial by dragging round the button, like a rotary phone, or with the wheel.
 */
function FloatingButton() {
  const favorites = useApp(selectQuickFavorites);
  const folders = useApp(selectQuickFolders);
  const incognito = useApp((s) => s.incognito);
  const enterIncognito = useApp((s) => s.enterIncognito);
  const exitIncognito = useApp((s) => s.exitIncognito);
  const sheet = useApp((s) => s.sheet);
  const controlsOn = useApp((s) => (s.state?.videoControls ?? VIDEO_CONTROLS_DEFAULT).panel);
  const darkMode = useApp((s) => s.state?.darkMode ?? DARK_MODE_DEFAULT);
  const darkSites = useApp((s) => s.state?.darkSites);
  const savedFavorites = useApp((s) => s.state?.favorites);
  const pageUrl = useApp((s) => selectPage(s)?.url);
  const pageSite = pageUrl ? siteOf(pageUrl) : null;
  const darkOn = darkActiveFor(darkMode, darkSites ?? {}, pageSite);
  const setDarkMode = useApp((s) => s.setDarkMode);
  const setSiteDarkMode = useApp((s) => s.setSiteDarkMode);
  const openSiteSheet = useApp((s) => s.openSiteSheet);
  const colorPickerOn = useApp((s) => s.state?.colorPicker ?? false);
  const techDetectorOn = useApp((s) => s.state?.techDetector ?? false);
  const downloadsOn = useDownloadsStore((s) => s.settings?.button ?? true);
  const downloadsBadge = useDownloadsStore((s) => s.active + s.unseen);
  const startTechDetect = useApp((s) => s.startTechDetect);
  const startColorPick = useApp((s) => s.startColorPick);
  const openSheet = useApp((s) => s.openSheet);
  const openFavorite = useApp((s) => s.openFavorite);
  const openSession = useApp((s) => s.openSession);
  const onboardingOpen = useApp((s) => s.onboardingOpen);
  const setFabEdge = useApp((s) => s.setFabEdge);
  const isPro = useEntitlementStore((state) => state.status === "pro");
  // Icons of sites that are open arrive after the fact; redraw when one does.
  useIconCache((cache) => cache.icons);
  const t = useT();
  const viewport = useViewport();
  const insets = useInsets();

  const [position, setPosition] = useState<FabPosition>(loadPosition);
  const [gesture, setGesture] = useState<GestureState>(idle);
  const [controlsCharging, setControlsCharging] = useState(false);
  const stopControlsHold = () => {
    clearTimeout(controlsHold.current);
    setControlsCharging(false);
  };
  const gestureRef = useRef<GestureState>(idle);
  const holdTimer = useRef(0);
  const ignorePress = useRef(false);
  const controlsHold = useRef(0);
  const controlsHeld = useRef(false);
  const [darkCharging, setDarkCharging] = useState(false);
  const stopDarkHold = () => {
    clearTimeout(darkHold.current);
    setDarkCharging(false);
  };
  const darkHold = useRef(0);
  const darkHeld = useRef(false);
  /** How far the dial is turned, in item steps, and whether a finger is turning it now. */
  const [rotation, setRotation] = useState(0);
  const [toolScroll, setToolScroll] = useState(0);
  const [turn, setTurn] = useState<"drag" | "snap" | null>(null);
  const spin = useRef<{ lane: Lane; start: Point; value: number; moved: boolean } | null>(null);
  const spunClick = useRef(false);
  const lastWheel = useRef(0);
  /** The folder whose favorites are showing in a popup. */
  const [folderName, setFolderName] = useState<string | null>(null);

  const list = useMemo(() => quickSlots(favorites, isPro), [favorites, isPro]);
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeId);
  const sites = useApp((s) => s.sites);
  const unread = useMemo(
    () => unreadByFavorite(sessions, usableQuickAccess(favorites, isPro), activeId, sites),
    [sessions, favorites, isPro, activeId, sites],
  );
  const anyUnread = unread.some((count) => count > 0);
  const resting = fabCenter(position.edge, position.yRatio * viewport.height, viewport, insets);

  // The ring lists quick access first (loose favorites, and folders as one item each, then the
  // locked slots Pro would open), then the open sites that are not quick access, then every other
  // favorite. A folder is listed once, where its first favorite is, and holds every favorite filed
  // in it.
  const usable = usableQuickAccess(favorites, isPro).length;
  const { quickItems, openTabs, restItems } = useMemo(() => {
    const taken = new Set<string>();
    const sessionOf = (favorite: Favorite) => {
      const session = sessionForFavorite(sessions, favorite.url, sites);
      if (session) taken.add(session.id);
      return session !== undefined;
    };
    const itemOf = (entry: ReturnType<typeof groupByFolder<Favorite>>[number]): FavoriteItem =>
      entry.kind === "favorite"
        ? { kind: "slot", index: entry.index, live: sessionOf(entry.favorite) }
        : {
            kind: "folder",
            name: entry.name,
            members: entry.members,
            live: entry.members.map((member) => sessionOf(member.favorite)).some(Boolean),
          };
    const range = (from: number, to: number) =>
      Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
    const quick = groupByFolder(favorites, range(0, usable)).map(itemOf);
    // The locked slots Pro would open come last.
    for (let index = usable; index < list.length; index++)
      quick.push({ kind: "slot", index, live: false });
    const listed = new Set(
      quick.flatMap((item) => (item.kind === "folder" ? [folderKey(item.name)] : [])),
    );
    const open = orderedTabs(sessions, activeId).filter((session) => !taken.has(session.id));
    // A favorite past quick access that is open is already among the open sites.
    const openIds = new Set(open.map((session) => session.id));
    const rest = groupByFolder(favorites, range(list.length, favorites.length))
      .filter((entry) =>
        entry.kind === "folder"
          ? !listed.has(folderKey(entry.name))
          : !(() => {
              const session = sessionForFavorite(sessions, entry.favorite.url, sites);
              return session !== undefined && openIds.has(session.id);
            })(),
      )
      .map(itemOf);
    return { quickItems: quick, openTabs: open, restItems: rest };
  }, [favorites, list, usable, sessions, sites, activeId]);

  const center: Point = gesture.phase === "dragging" ? gesture.position : resting;
  const fanOpen = gesture.phase === "fan";
  const hover = gesture.phase === "fan" ? gesture.hover : null;

  const desktop = useApp((s) => s.desktop);
  const workspaces = useApp((s) => s.state?.workspaces);
  const openWorkspace = useApp((s) => s.openWorkspace);
  const savedWorkspaces =
    desktop && !incognito.active ? (workspaces ?? NO_WORKSPACES) : NO_WORKSPACES;
  /** The favorite or open page a dial button stands for, which can be dragged onto the page. */
  const carryOf = (target: FanTarget): Carry | null => {
    if (!desktop) return null;
    if (target.kind === "tab") {
      const session = sessions.find((entry) => entry.id === target.sessionId);
      if (!session) return null;
      const url = session.url ?? session.openedUrl;
      return {
        page: { kind: "session", id: session.id },
        label: session.title?.trim() || displayHost(url),
        icon: iconForUrl(url, favorites),
      };
    }
    if (target.kind !== "favorite") return null;
    const { favorite, locked } = slotAt(target.index);
    return favorite && !locked
      ? { page: { kind: "favorite", favorite }, label: favorite.name, icon: favorite.icon }
      : null;
  };
  /** The last favorite or tab the finger slid over, so sliding on out of the dial carries it. */
  const lastHover = useRef<FanTarget | null>(null);

  /** A favorite's place in the quick-access menu, or past it: then it is only locked without Pro. */
  const slotAt = (index: number) =>
    list[index] ?? {
      favorite: favorites[index] ?? null,
      locked: !isPro && index >= FREE_QUICK_ACCESS_LIMIT,
    };

  const select = (target: FanTarget) => {
    if (target.kind === "settings") openSheet("settings");
    else if (target.kind === "history") openSheet("history");
    else if (target.kind === "tabs") openSheet("tabs");
    else if (target.kind === "stats") openSheet("stats");
    else if (target.kind === "incognito")
      void (incognito.active ? exitIncognito() : enterIncognito());
    else if (target.kind === "colorPicker") void startColorPick();
    else if (target.kind === "techDetector") void startTechDetect();
    else if (target.kind === "downloads") openSheet("downloads");
    else if (target.kind === "tab") openSession(target.sessionId);
    else if (target.kind === "folder") setFolderName(target.name);
    else if (target.kind === "darkMode") {
      if (pageSite) {
        void setSiteDarkMode(pageSite, { ...darkSites?.[pageSite], mode: darkOn ? "off" : "on" });
      } else void setDarkMode({ enabled: !darkOn });
    } else if (target.kind === "controls") {
      setVideoPanel(!controlsOn);
    } else if (target.kind === "workspace") {
      const workspace = savedWorkspaces.find((entry) => entry.id === target.id);
      if (workspace) openWorkspace(workspace);
    } else {
      const slot = slotAt(target.index);
      if (slot.locked) openSheet("paywall");
      else if (slot.favorite) openFavorite(slot.favorite);
    }
  };

  const favoriteEntry = (index: number, section: number, open: boolean): Entry => {
    const { favorite, locked } = slotAt(index);
    const name = favorite?.name ?? "";
    return {
      lane: "ring",
      target: { kind: "favorite", index },
      size: FAVORITE_SIZE,
      section,
      label: locked
        ? t("paywall.title")
        : unread[index] > 0
          ? `${t("fab.openFavorite", { name })}. ${t("notify.newActivity")}`
          : t("fab.openFavorite", { name }),
      caption: favorite?.name,
      site: true,
      className: `text-lg font-medium text-white ${locked ? "brightness-75 grayscale" : ""}`,
      content: (
        <>
          {favorite?.icon ? (
            <img src={favorite.icon} alt="" draggable={false} className="size-7 rounded-md" />
          ) : favorite ? (
            monogram(favorite.name)
          ) : (
            <ProIcon />
          )}
          {locked && favorite && (
            <span className="pro-badge absolute -end-1.5 -top-1.5 z-10 grid size-5 place-items-center rounded-full">
              <ProIcon size={12} />
            </span>
          )}
          {(unread[index] ?? 0) > 0 && <UnreadBadge count={unread[index]} />}
          {open && <OpenDot />}
        </>
      ),
    };
  };

  const folderEntry = (item: Extract<FavoriteItem, { kind: "folder" }>, section: number): Entry => {
    const unreadCount = item.members.reduce((sum, member) => sum + (unread[member.index] ?? 0), 0);
    return {
      lane: "ring",
      target: { kind: "folder", name: item.name },
      size: FAVORITE_SIZE,
      section,
      label:
        unreadCount > 0
          ? `${t("favorites.folderOpen", { name: item.name })}. ${t("notify.newActivity")}`
          : t("favorites.folderOpen", { name: item.name }),
      caption: item.name,
      site: true,
      className: "text-white",
      content: (
        <>
          {folderIcon(folders, item.name) ? (
            <span aria-hidden="true" className="text-[22px] leading-none">
              {folderIcon(folders, item.name)}
            </span>
          ) : (
            <span className="grid grid-cols-2 gap-0.5">
              {item.members.slice(0, 4).map(({ favorite }) =>
                favorite.icon ? (
                  <img
                    key={favorite.id}
                    src={favorite.icon}
                    alt=""
                    draggable={false}
                    className="size-[18px] rounded-[5px]"
                  />
                ) : (
                  <span
                    key={favorite.id}
                    className="grid size-[18px] place-items-center rounded-[5px] bg-white/25 text-[10px] leading-none font-semibold"
                  >
                    {monogram(favorite.name)}
                  </span>
                ),
              )}
            </span>
          )}
          {unreadCount > 0 && <UnreadBadge count={unreadCount} />}
          {item.live && <OpenDot />}
        </>
      ),
    };
  };

  const itemEntry = (item: FavoriteItem, section: number): Entry =>
    item.kind === "slot"
      ? favoriteEntry(item.index, section, item.live)
      : folderEntry(item, section);

  const tabEntry = (session: Session): Entry => {
    const url = session.url ?? session.openedUrl;
    const name = session.title?.trim() || displayHost(url);
    const icon = iconForUrl(url, favorites);
    return {
      lane: "ring",
      target: { kind: "tab", sessionId: session.id },
      size: FAVORITE_SIZE,
      section: OPEN,
      label: t("fab.openFavorite", { name }),
      caption: name,
      site: true,
      className: "text-lg font-medium text-white",
      content: (
        <>
          {icon ? (
            <img src={icon} alt="" draggable={false} className="size-7 rounded-md" />
          ) : (
            monogram(displayHost(url))
          )}
          <OpenDot />
        </>
      ),
    };
  };

  const tool = (
    kind: "history" | "tabs" | "stats" | "settings" | "colorPicker" | "techDetector" | "downloads",
    size: number,
    label: string,
    content: ReactNode,
  ): Entry => ({ lane: "tools", target: { kind }, size, section: QUICK, label, content });

  // Top to bottom, as the page column reads; a column running upward from the button lists the
  // other way round.
  const pageTop: Entry[] = [
    tool(
      "stats",
      STATS_SIZE,
      t("fab.usage"),
      <>
        <StatsIcon />
        {!isPro && (
          <span className="pro-badge absolute -end-1.5 -top-1.5 z-10 grid size-5 place-items-center rounded-full">
            <ProIcon size={12} />
          </span>
        )}
      </>,
    ),
    tool("tabs", TABS_SIZE, t("fab.tabs"), <TabsIcon />),
    tool("history", HISTORY_SIZE, t("fab.history"), <HistoryIcon />),
    tool("settings", SETTINGS_SIZE, t("fab.settings"), <SlidersIcon />),
  ];
  const switchTools: Entry[] = [
    {
      lane: "tools",
      target: { kind: "incognito" },
      size: INCOGNITO_SIZE,
      section: QUICK,
      label: t(incognito.active ? "fab.leaveIncognito" : "fab.incognito"),
      active: incognito.active,
      pressed: incognito.active,
      busy: incognito.busy,
      caption: incognito.active ? t("fab.leaveIncognitoHint") : undefined,
      className: `${incognito.active ? "" : "text-white"} ${incognito.busy ? "animate-pulse" : ""}`,
      content: (
        <>
          <IncognitoIcon active={incognito.active} />
          {!isPro ? (
            <span className="pro-badge absolute -end-1.5 -top-1.5 z-10 grid size-5 place-items-center rounded-full">
              <ProIcon size={12} />
            </span>
          ) : (
            !incognito.active && (
              <span className="absolute -end-1.5 -top-1.5 z-10 grid size-5 place-items-center rounded-full border border-white/70 bg-black/80 text-white">
                <BiometricIcon size={12} />
              </span>
            )
          )}
        </>
      ),
    },
    {
      lane: "tools",
      target: { kind: "controls" },
      size: CONTROLS_SIZE,
      section: QUICK,
      label: t("fab.videoControls"),
      active: controlsOn,
      pressed: controlsOn,
      content: <VideoControlsIcon on={controlsOn} />,
      charging: controlsCharging,
    },
    {
      lane: "tools",
      target: { kind: "darkMode" },
      size: DARK_MODE_SIZE,
      section: QUICK,
      label: t(pageSite ? "fab.darkModeSite" : "fab.darkMode"),
      active: darkOn,
      pressed: darkOn,
      content: <MoonIcon on={darkOn} />,
      charging: darkCharging,
    },
    ...(colorPickerOn
      ? [tool("colorPicker", COLOR_PICKER_SIZE, t("fab.colorPicker"), <ColorPickerIcon />)]
      : []),
    ...(techDetectorOn
      ? [tool("techDetector", TECH_DETECTOR_SIZE, t("fab.techDetector"), <TechIcon />)]
      : []),
    ...(downloadsOn
      ? [
          tool(
            "downloads",
            DOWNLOADS_SIZE,
            t("fab.downloads"),
            <>
              <DownloadIcon />
              {downloadsBadge > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -end-1 -top-1 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] leading-4 font-semibold text-on-accent"
                >
                  {downloadsBadge}
                </span>
              )}
            </>,
          ),
        ]
      : []),
  ];
  const workspaceEntry = (workspace: Workspace): Entry => ({
    lane: "ring",
    target: { kind: "workspace", id: workspace.id },
    size: FAVORITE_SIZE,
    section: QUICK,
    label: t("tile.workspaceOpen", { name: workspace.name }),
    caption: workspace.name,
    site: true,
    className: "text-white",
    content: <TilesIcon />,
  });
  const ringEntries: Entry[] = [
    ...quickItems.map((item) => itemEntry(item, QUICK)),
    ...savedWorkspaces.map(workspaceEntry),
    ...openTabs.map(tabEntry),
    ...restItems.map((item) => itemEntry(item, REST)),
  ];

  const dialItems: DialItem[] = ringEntries.map(({ target, size, section }) => ({
    target,
    size,
    section,
  }));
  const arc = dialWindow(resting, position.edge, viewport, insets);
  const turned = clampRotation(rotation, dialItems, arc);
  const ringSlots = dialSlots(resting, position.edge, viewport, insets, dialItems, turned);
  // One vertical line through the button. Top to bottom, the page buttons are below it and the
  // switches above (or the other way round, where there is more room above), as before.
  const plan = toolPlan(resting, viewport, insets);
  const above = plan.pageBelow ? [...switchTools].reverse() : pageTop;
  const below = plan.pageBelow ? pageTop : switchTools;
  const lineItems = [...above, ...below];
  const scrollRange = toolScrollRange(
    resting,
    viewport,
    insets,
    lineItems.length,
    above.length,
    plan,
  );
  const scrolled = Math.min(Math.max(toolScroll, scrollRange.min), scrollRange.max);
  const entries = [...ringEntries, ...lineItems];
  const slots = [
    ...ringSlots,
    ...toolSlots(resting, viewport, insets, lineItems, above.length, plan, scrolled),
  ];

  const folderMembers: FolderMember[] =
    folderName === null
      ? []
      : (
          groupByFolder(favorites).flatMap((entry) =>
            entry.kind === "folder" && folderKey(entry.name) === folderKey(folderName)
              ? [entry.members]
              : [],
          )[0] ?? []
        ).map(({ favorite, index }) => ({
          favorite,
          index,
          locked: !isPro && index >= FREE_QUICK_ACCESS_LIMIT,
          live: sessionForFavorite(sessions, favorite.url, sites) !== undefined,
          unread: unread[index] ?? 0,
        }));

  const moveTo = (stored: FabPosition) => {
    setPosition(stored);
    savePosition(stored);
    setFabEdge(stored.edge);
  };

  const apply = (effect: GestureEffect) => {
    switch (effect.type) {
      case "tap":
        openSheet("assistant");
        break;
      case "snap": {
        const pushed = pushedOffEdge(effect.drop, viewport);
        const next = pushed
          ? { edge: pushed, y: peekCenterY(effect.drop.y, viewport, insets) }
          : snapToEdge(effect.drop, viewport, insets);
        moveTo({ edge: next.edge, yRatio: next.y / viewport.height, hidden: pushed !== null });
        break;
      }
      case "select":
        select(effect.target);
        break;
      case "openFan":
        setRotation(0);
        setToolScroll(0);
        setTurn(null);
        break;
      case "closeFan":
        break;
    }
  };

  const dispatch = (event: GestureEvent) => {
    const step = reduceGesture(gestureRef.current, event);
    gestureRef.current = step.state;
    setGesture(step.state);
    step.effects.forEach(apply);
  };
  useBackHandler(fanOpen, () => dispatch({ type: "dismiss" }));

  const pointOf = (event: PointerEvent | WheelEvent): Point => ({
    x: event.clientX,
    y: event.clientY,
  });
  const hitAt = (point: Point) =>
    gestureRef.current.phase === "fan" ? dialTargetAt(point, slots) : null;

  // Turning the dial: a finger dragging round the button moves the items with it.
  /** What a finger at `point` turns: the line when it is on it, else the ring. */
  const laneAt = (point: Point): Lane =>
    Math.abs(point.x - resting.x) <= COLUMN_BAND && Math.abs(point.y - resting.y) >= MIN_TURN_RADIUS
      ? "tools"
      : "ring";
  const valueOf = (lane: Lane) => (lane === "ring" ? turned : scrolled);
  const beginSpin = (event: PointerEvent<HTMLElement>, lane?: Lane) => {
    const start = pointOf(event);
    const chosen = lane ?? laneAt(start);
    spin.current =
      Math.hypot(start.x - resting.x, start.y - resting.y) < MIN_TURN_RADIUS
        ? null
        : { lane: chosen, start, value: valueOf(chosen), moved: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // capture is best-effort: the pointer may already be gone
    }
  };
  const moveSpin = (event: PointerEvent<HTMLElement>) => {
    const current = spin.current;
    if (!current) return;
    const point = pointOf(event);
    if (!current.moved) {
      if (Math.hypot(point.x - current.start.x, point.y - current.start.y) <= DRAG_SLOP) return;
      current.moved = true;
      stopControlsHold();
      stopDarkHold();
      setTurn("drag");
    }
    if (current.lane === "tools") {
      // The buttons follow the finger along the line.
      const slid = (point.y - current.start.y) / TOOL_STEP;
      setToolScroll(Math.min(Math.max(current.value + slid, scrollRange.min), scrollRange.max));
      return;
    }
    if (Math.hypot(point.x - resting.x, point.y - resting.y) < MIN_TURN_RADIUS) return;
    setRotation(
      clampRotation(
        current.value + dialTurn(resting, position.edge, current.start, point),
        dialItems,
        arc,
      ),
    );
  };
  /** Lets go of the dial or a column. True when it was moved, so the lift is not also a tap. */
  const endSpin = () => {
    const current = spin.current;
    spin.current = null;
    if (!current?.moved) return false;
    spunClick.current = true;
    window.setTimeout(() => (spunClick.current = false), 60);
    setTurn("snap");
    if (current.lane === "ring") setRotation(snapRotation(turned, dialItems, arc));
    else setToolScroll(snapToolScroll(scrolled, scrollRange));
    return true;
  };
  const onWheel = (event: WheelEvent) => {
    if (
      !fanOpen ||
      Math.abs(event.deltaY) < 4 ||
      event.timeStamp - lastWheel.current < WHEEL_GAP_MS
    )
      return;
    lastWheel.current = event.timeStamp;
    setTurn("snap");
    const lane = laneAt(pointOf(event));
    if (lane === "ring") {
      setRotation(snapRotation(turned + Math.sign(event.deltaY), dialItems, arc));
      return;
    }
    setToolScroll(snapToolScroll(scrolled + Math.sign(event.deltaY), scrollRange));
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // capture is best-effort: the pointer may already be gone
    }
    if (gestureRef.current.phase === "fan") {
      ignorePress.current = true;
      dispatch({ type: "dismiss" });
      return;
    }
    dispatch({ type: "down", point: pointOf(event) });
    holdTimer.current = window.setTimeout(() => dispatch({ type: "holdElapsed" }), HOLD_MS);
  };

  /** A button of the dial is dragged out of it: the page it stands for goes with the pointer. */
  const startCarry = (event: PointerEvent<HTMLElement>, carry: Carry) => {
    spin.current = null;
    setTurn(null);
    beginTileDrag(event, carry.page, carry.label, carry.icon);
    dispatch({ type: "dismiss" });
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (ignorePress.current) return;
    const point = pointOf(event);
    if (gestureRef.current.phase === "dragging") clearTimeout(holdTimer.current);
    if (gestureRef.current.phase !== "fan") lastHover.current = null;
    const hit = hitAt(point);
    if (hit) lastHover.current = hit;
    // A finger that slid onto a favorite and on past the dial takes the favorite with it.
    const held = lastHover.current;
    if (
      gestureRef.current.phase === "fan" &&
      !hit &&
      held &&
      Math.hypot(point.x - resting.x, point.y - resting.y) > DIAL_RADIUS + FAVORITE_SIZE
    ) {
      const carry = carryOf(held);
      if (carry) {
        lastHover.current = null;
        startCarry(event, carry);
        return;
      }
    }
    dispatch({ type: "move", point, hit });
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    clearTimeout(holdTimer.current);
    if (ignorePress.current) {
      ignorePress.current = false;
      return;
    }
    const point = pointOf(event);
    dispatch({ type: "up", point, hit: hitAt(point) });
  };

  const onPointerCancel = () => {
    clearTimeout(holdTimer.current);
    ignorePress.current = false;
    dispatch({ type: "dismiss" });
  };

  const hidden = sheet !== "none" || onboardingOpen;
  const tucked = position.hidden;
  const pushing =
    gesture.phase === "dragging" && pushedOffEdge(gesture.position, viewport) !== null;
  const tuckShift = position.edge === "left" ? -FAB_SIZE : FAB_SIZE;
  const PeekIcon = position.edge === "left" ? ChevronRightIcon : ChevronLeftIcon;
  const holdState = gesture.phase === "pressing" ? "charging" : fanOpen ? "open" : "idle";
  const enlarged = gesture.phase === "pressing" || fanOpen;

  /** What pressing and holding a button does, for the two that have it. */
  const holdOf = (kind: FanTarget["kind"]) => {
    if (kind === "controls") {
      return {
        start: () => {
          controlsHeld.current = false;
          setControlsCharging(true);
          controlsHold.current = window.setTimeout(() => {
            controlsHeld.current = true;
            setControlsCharging(false);
            openSheet("video-controls");
            dispatch({ type: "dismiss" });
          }, HOLD_MS);
        },
        stop: stopControlsHold,
        consumeHeld: () => {
          const was = controlsHeld.current;
          controlsHeld.current = false;
          return was;
        },
      };
    }
    if (kind === "darkMode") {
      return {
        start: () => {
          darkHeld.current = false;
          setDarkCharging(true);
          darkHold.current = window.setTimeout(() => {
            darkHeld.current = true;
            setDarkCharging(false);
            const own = pageSite ? usableQuickAccess(savedFavorites ?? [], isPro) : [];
            const match = own.find((favorite) => siteOf(favorite.url) === pageSite);
            if (pageSite && match && !incognito.active)
              openSiteSheet("site-dark-mode", pageSite, match.name);
            else openSheet("dark-mode");
            dispatch({ type: "dismiss" });
          }, HOLD_MS);
        },
        stop: stopDarkHold,
        consumeHeld: () => {
          const was = darkHeld.current;
          darkHeld.current = false;
          return was;
        },
      };
    }
    return null;
  };

  /** A lift on a button: selects it, unless the finger had just turned the dial or held it. */
  const activate = (target: FanTarget, hold: Hold | null) => {
    if (spunClick.current) {
      spunClick.current = false;
      return;
    }
    if (hold?.consumeHeld()) return;
    select(target);
    dispatch({ type: "dismiss" });
  };

  return (
    <>
      <div
        data-hit={fanOpen ? "" : undefined}
        onPointerDown={(event) => beginSpin(event)}
        onPointerMove={moveSpin}
        onPointerUp={() => {
          if (!endSpin()) dispatch({ type: "dismiss" });
        }}
        onPointerCancel={() => void endSpin()}
        onWheel={onWheel}
        style={{ touchAction: "none" }}
        className={`fan-scrim fixed inset-0 bg-black/45 transition-opacity duration-200 ${
          fanOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {entries.map((entry, index) => (
        <DialButton
          key={targetKey(entry.target)}
          entry={entry}
          slot={slots[index]}
          index={index}
          count={entries.length}
          origin={center}
          edge={position.edge}
          fanOpen={fanOpen}
          hovered={sameTarget(hover, entry.target)}
          turn={turn}
          holdOf={holdOf}
          onSpinStart={beginSpin}
          onSpinMove={moveSpin}
          onSpinEnd={endSpin}
          onWheel={onWheel}
          onActivate={activate}
          carry={carryOf(entry.target)}
          onCarry={startCarry}
        />
      ))}

      {folderName !== null && folderMembers.length > 0 && !hidden && (
        <FolderPopup
          name={folderName}
          icon={folderIcon(folders, folderName)}
          members={folderMembers}
          onClose={() => setFolderName(null)}
          onCarry={
            desktop
              ? (member, event) => {
                  setFolderName(null);
                  beginTileDrag(
                    event,
                    { kind: "favorite", favorite: member.favorite },
                    member.favorite.name,
                    member.favorite.icon,
                  );
                }
              : undefined
          }
          onPick={(member) => {
            setFolderName(null);
            if (member.locked) openSheet("paywall");
            else openFavorite(member.favorite);
          }}
        />
      )}

      {tucked && !hidden && (
        <button
          type="button"
          data-hit=""
          aria-label={t("fab.show")}
          onClick={() => moveTo({ ...position, hidden: false })}
          style={{
            top: peekCenterY(position.yRatio * viewport.height, viewport, insets) - PEEK_HEIGHT / 2,
            width: PEEK_WIDTH,
            height: PEEK_HEIGHT,
          }}
          className={`fab-peek fab-glass fixed z-30 grid place-items-center text-white ${
            position.edge === "left" ? "left-0 rounded-r-full" : "right-0 rounded-l-full"
          }`}
          data-edge={position.edge}
        >
          <PeekIcon size={18} />
        </button>
      )}

      <button
        type="button"
        data-hit={hidden || tucked ? undefined : ""}
        data-hold={holdState}
        tabIndex={tucked ? -1 : undefined}
        aria-hidden={tucked || undefined}
        aria-label={t("fab.assistant")}
        aria-expanded={fanOpen}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(event) => event.preventDefault()}
        style={{
          width: FAB_SIZE,
          height: FAB_SIZE,
          transform: `translate(${center.x - FAB_SIZE / 2 + (tucked ? tuckShift : 0)}px, ${center.y - FAB_SIZE / 2}px)${
            enlarged ? ` scale(${HOLD_SCALE})` : ""
          }`,
          opacity: pushing ? 0.45 : tucked ? 0 : undefined,
          transition:
            gesture.phase === "dragging"
              ? "none"
              : "transform 320ms var(--ease-spring), opacity 200ms",
          touchAction: "none",
        }}
        className={`fab fixed top-0 left-0 z-30 grid place-items-center rounded-full ${hidden || tucked ? "pointer-events-none" : ""} ${hidden ? "opacity-0" : ""}`}
      >
        <img src={logoMark} alt="" draggable={false} className="fab-logo relative size-10" />
        {anyUnread && !fanOpen && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -end-0.5 -top-0.5 z-10 size-3.5 rounded-full border-2 border-ink bg-accent"
          />
        )}
        {incognito.active && (
          <span
            aria-hidden="true"
            className="incognito-badge absolute -bottom-1 -end-1 z-10 grid size-6 place-items-center rounded-full border border-white/70 bg-black/80 text-white"
          >
            <IncognitoIcon active size={14} />
          </span>
        )}
        <svg className="fab-ring" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="31" pathLength="1" />
        </svg>
      </button>
    </>
  );
}

/**
 * The floating button, unless a desktop person who works by keys alone has hidden it. Hiding it
 * unmounts it, so nothing of it stays on the page or takes a click.
 */
export function Fab() {
  const desktop = useApp((s) => s.desktop);
  const hidden = useKeybindings(selectFabHidden);
  if (desktop && hidden) return null;
  return <FloatingButton />;
}
