import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { selectPage, selectQuickFavorites, useApp } from "../../app/store";
import { unreadByFavorite } from "../web/unreadWatch";
import { sessionForFavorite, type Session } from "../web/sessions";
import { FolderPopup, type FolderMember } from "./FolderPopup";
import { orderedTabs } from "../tabs/tabs";
import { useT } from "../../i18n/useT";
import {
  FREE_QUICK_ACCESS_LIMIT,
  displayHost,
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
  snapToEdge,
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
  VideoControlsIcon,
} from "../../shared/icons";
import { useBackHandler } from "../back/useBackHandler";
import logoMark from "../../assets/logo-mark.svg";
import { useEntitlementStore } from "../paywall/store";
import { useDownloadsStore } from "../downloads/store";

const idle: GestureState = { phase: "idle" };

const monogram = (name: string) => name.trim().charAt(0).toUpperCase() || "·";

/** Closer to the button than this, a finger's angle round it is too jumpy to turn the dial with. */
const MIN_TURN_RADIUS = 40;
/** Minimum time between wheel notches, so a trackpad flick turns the dial a stop or two. */
const WHEEL_GAP_MS = 120;

/** The dial's sections, in the order they appear going round it. */
const TOOLS = 0;
const OPEN = 1;
const CLOSED = 2;

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

const targetKey = (target: FanTarget) =>
  target.kind === "favorite"
    ? `favorite:${target.index}`
    : target.kind === "tab"
      ? `tab:${target.sessionId}`
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
  onSpinStart: (event: PointerEvent<HTMLElement>) => void;
  onSpinMove: (event: PointerEvent<HTMLElement>) => void;
  onSpinEnd: () => boolean;
  onWheel: (event: WheelEvent) => void;
  onActivate: (target: FanTarget, hold: Hold | null) => void;
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
}: DialButtonProps) {
  const hold = holdOf(entry.target.kind);
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
        onSpinStart(event);
        hold?.start();
      }}
      onPointerMove={onSpinMove}
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
export function Fab() {
  const favorites = useApp(selectQuickFavorites);
  const incognito = useApp((s) => s.incognito);
  const enterIncognito = useApp((s) => s.enterIncognito);
  const exitIncognito = useApp((s) => s.exitIncognito);
  const sheet = useApp((s) => s.sheet);
  const controlsOn = useApp((s) => (s.state?.videoControls ?? VIDEO_CONTROLS_DEFAULT).panel);
  const setVideoControls = useApp((s) => s.setVideoControls);
  const darkMode = useApp((s) => s.state?.darkMode ?? DARK_MODE_DEFAULT);
  const darkSites = useApp((s) => s.state?.darkSites);
  const savedFavorites = useApp((s) => s.state?.favorites);
  const pageUrl = useApp((s) => selectPage(s)?.url);
  const pageSite = pageUrl ? siteOf(pageUrl) : null;
  const darkOn = darkActiveFor(darkMode, darkSites ?? {}, pageSite);
  const setDarkMode = useApp((s) => s.setDarkMode);
  const setSiteDarkMode = useApp((s) => s.setSiteDarkMode);
  const openSiteSheet = useApp((s) => s.openSiteSheet);
  // The page script runs through native code that desktop has no site view for.
  const colorPickerOn = useApp((s) => (s.state?.colorPicker ?? false) && !s.desktop);
  const techDetectorOn = useApp((s) => (s.state?.techDetector ?? false) && !s.desktop);
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
  const [turn, setTurn] = useState<"drag" | "snap" | null>(null);
  const spin = useRef<{ start: Point; rotation: number; moved: boolean } | null>(null);
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

  // Favorites (loose ones, and folders as one item each) whose site is open come first, then the
  // other open sites; the rest of the favorites are closed. A folder is listed when one of its
  // favorites is in quick access, and holds every favorite filed in it.
  const usable = usableQuickAccess(favorites, isPro).length;
  const { favoriteItems, otherTabs } = useMemo(() => {
    const taken = new Set<string>();
    const sessionOf = (favorite: Favorite) => {
      const session = sessionForFavorite(sessions, favorite.url, sites);
      if (session) taken.add(session.id);
      return session !== undefined;
    };
    const shown = Array.from({ length: usable }, (_, index) => index);
    const items: FavoriteItem[] = groupByFolder(favorites, shown).map((entry) =>
      entry.kind === "favorite"
        ? { kind: "slot", index: entry.index, live: sessionOf(entry.favorite) }
        : {
            kind: "folder",
            name: entry.name,
            members: entry.members,
            live: entry.members.map((member) => sessionOf(member.favorite)).some(Boolean),
          },
    );
    // The locked slots Pro would open come last.
    for (let index = usable; index < list.length; index++)
      items.push({ kind: "slot", index, live: false });
    return {
      favoriteItems: items,
      otherTabs: orderedTabs(sessions, activeId).filter((session) => !taken.has(session.id)),
    };
  }, [favorites, list, usable, sessions, sites, activeId]);

  const center: Point = gesture.phase === "dragging" ? gesture.position : resting;
  const fanOpen = gesture.phase === "fan";
  const hover = gesture.phase === "fan" ? gesture.hover : null;

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
      // The quick switch is for every site: a site's own "on" would keep the panel showing there.
      const next = !controlsOn;
      void setVideoControls({ panel: next });
      if (!next) {
        const { state, setSiteVideoControls } = useApp.getState();
        for (const [site, own] of Object.entries(state?.videoSites ?? {})) {
          if (own.panel === true) void setSiteVideoControls(site, { ...own, panel: undefined });
        }
      }
    } else {
      const slot = list[target.index];
      if (slot?.locked) openSheet("paywall");
      else if (slot?.favorite) openFavorite(slot.favorite);
    }
  };

  const favoriteEntry = (index: number, section: number, open: boolean): Entry => {
    const { favorite, locked } = list[index];
    const name = favorite?.name ?? "";
    return {
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
          {unread[index] > 0 && <UnreadBadge count={unread[index]} />}
          {open && <OpenDot />}
        </>
      ),
    };
  };

  const folderEntry = (item: Extract<FavoriteItem, { kind: "folder" }>, section: number): Entry => {
    const unreadCount = item.members.reduce((sum, member) => sum + (unread[member.index] ?? 0), 0);
    return {
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
  ): Entry => ({ target: { kind }, size, section: TOOLS, label, content });

  const entries: Entry[] = [
    tool("history", HISTORY_SIZE, t("fab.history"), <HistoryIcon />),
    tool("tabs", TABS_SIZE, t("fab.tabs"), <TabsIcon />),
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
    {
      target: { kind: "incognito" },
      size: INCOGNITO_SIZE,
      section: TOOLS,
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
      target: { kind: "controls" },
      size: CONTROLS_SIZE,
      section: TOOLS,
      label: t("fab.videoControls"),
      active: controlsOn,
      pressed: controlsOn,
      content: <VideoControlsIcon on={controlsOn} />,
      charging: controlsCharging,
    },
    {
      target: { kind: "darkMode" },
      size: DARK_MODE_SIZE,
      section: TOOLS,
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
    tool("settings", SETTINGS_SIZE, t("fab.settings"), <SlidersIcon />),
    ...favoriteItems.filter((item) => item.live).map((item) => itemEntry(item, OPEN)),
    ...otherTabs.map(tabEntry),
    ...favoriteItems.filter((item) => !item.live).map((item) => itemEntry(item, CLOSED)),
  ];

  const dialItems: DialItem[] = entries.map(({ target, size, section }) => ({
    target,
    size,
    section,
  }));
  const arc = dialWindow(resting, position.edge, viewport, insets);
  const turned = clampRotation(rotation, dialItems, arc);
  const slots = dialSlots(resting, position.edge, viewport, insets, dialItems, turned);

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
  const beginSpin = (event: PointerEvent<HTMLElement>) => {
    const start = pointOf(event);
    spin.current =
      Math.hypot(start.x - resting.x, start.y - resting.y) < MIN_TURN_RADIUS
        ? null
        : { start, rotation: turned, moved: false };
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
    if (Math.hypot(point.x - resting.x, point.y - resting.y) < MIN_TURN_RADIUS) return;
    setRotation(
      clampRotation(
        current.rotation + dialTurn(resting, position.edge, current.start, point),
        dialItems,
        arc,
      ),
    );
  };
  /** Lets go of the dial. True when it was turned, so the lift is not also a tap. */
  const endSpin = () => {
    const current = spin.current;
    spin.current = null;
    if (!current?.moved) return false;
    spunClick.current = true;
    window.setTimeout(() => (spunClick.current = false), 60);
    setTurn("snap");
    setRotation(snapRotation(turned, dialItems, arc));
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
    setRotation(snapRotation(turned + Math.sign(event.deltaY), dialItems, arc));
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

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (ignorePress.current) return;
    const point = pointOf(event);
    if (gestureRef.current.phase === "dragging") clearTimeout(holdTimer.current);
    dispatch({ type: "move", point, hit: hitAt(point) });
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
        onPointerDown={beginSpin}
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
        />
      ))}

      {folderName !== null && folderMembers.length > 0 && !hidden && (
        <FolderPopup
          name={folderName}
          members={folderMembers}
          onClose={() => setFolderName(null)}
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
