import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { selectQuickFavorites, useApp } from "../../app/store";
import { unreadByFavorite } from "../web/unreadWatch";
import { useT } from "../../i18n/useT";
import { quickSlots, usableQuickAccess } from "../../shared/favorites";
import { VIDEO_CONTROLS_DEFAULT } from "../../shared/videoControls";
import { useInsets, useViewport } from "../../shared/viewport";
import {
  FAB_SIZE,
  FAVORITE_SIZE,
  HISTORY_SIZE,
  HOLD_SCALE,
  CONTROLS_SIZE,
  INCOGNITO_SIZE,
  PEEK_HEIGHT,
  PEEK_WIDTH,
  SETTINGS_SIZE,
  STATS_SIZE,
  TABS_SIZE,
  fabCenter,
  fanLayout,
  fanTargetAt,
  peekCenterY,
  pushedOffEdge,
  snapToEdge,
  type FanTarget,
  type Point,
} from "./geometry";
import {
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
  HistoryIcon,
  IncognitoIcon,
  ProIcon,
  SlidersIcon,
  StatsIcon,
  TabsIcon,
  VideoControlsIcon,
} from "../../shared/icons";
import { useBackHandler } from "../back/useBackHandler";
import logoMark from "../../assets/logo-mark.svg";
import { useEntitlementStore } from "../paywall/store";

const idle: GestureState = { phase: "idle" };

const monogram = (name: string) => name.trim().charAt(0).toUpperCase() || "·";

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

interface FanStyle extends CSSProperties {
  "--dx": string;
  "--dy": string;
  "--i": number;
  "--n": number;
}

/**
 * The floating button. Tap: assistant. Drag: move, then snap to the nearer edge. Hold: fan out
 * the favorites and settings; slide onto one and lift, or lift and tap.
 */
export function Fab() {
  const favorites = useApp(selectQuickFavorites);
  const incognito = useApp((s) => s.incognito);
  const enterIncognito = useApp((s) => s.enterIncognito);
  const exitIncognito = useApp((s) => s.exitIncognito);
  const sheet = useApp((s) => s.sheet);
  const controlsOn = useApp((s) => (s.state?.videoControls ?? VIDEO_CONTROLS_DEFAULT).panel);
  const setVideoControls = useApp((s) => s.setVideoControls);
  const openSheet = useApp((s) => s.openSheet);
  const openFavorite = useApp((s) => s.openFavorite);
  const onboardingOpen = useApp((s) => s.onboardingOpen);
  const setFabEdge = useApp((s) => s.setFabEdge);
  const isPro = useEntitlementStore((state) => state.status === "pro");
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
  const layout = useMemo(
    () => fanLayout(resting, position.edge, viewport, insets, list.length),
    // resting is derived from these inputs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [position, viewport, insets, list.length],
  );

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
    else if (target.kind === "controls") {
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

  const pointOf = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY });
  const hitAt = (point: Point) =>
    gestureRef.current.phase === "fan" ? fanTargetAt(point, layout) : null;

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

  const fanStyle = (target: Point, index: number): FanStyle => ({
    left: target.x,
    top: target.y,
    "--dx": `${center.x - target.x}px`,
    "--dy": `${center.y - target.y}px`,
    "--i": index,
    "--n": list.length + 6,
  });

  const hidden = sheet !== "none" || onboardingOpen;
  const tucked = position.hidden;
  const pushing =
    gesture.phase === "dragging" && pushedOffEdge(gesture.position, viewport) !== null;
  const tuckShift = position.edge === "left" ? -FAB_SIZE : FAB_SIZE;
  const PeekIcon = position.edge === "left" ? ChevronRightIcon : ChevronLeftIcon;
  const holdState = gesture.phase === "pressing" ? "charging" : fanOpen ? "open" : "idle";
  const enlarged = gesture.phase === "pressing" || fanOpen;

  return (
    <>
      <div
        data-hit={fanOpen ? "" : undefined}
        onPointerDown={() => dispatch({ type: "dismiss" })}
        className={`fan-scrim fixed inset-0 bg-black/45 transition-opacity duration-200 ${
          fanOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {list.map(({ favorite, locked }, index) => (
        <button
          key={favorite?.id ?? `locked-${index}`}
          type="button"
          data-open={fanOpen}
          aria-label={
            locked
              ? t("paywall.title")
              : unread[index] > 0
                ? `${t("fab.openFavorite", { name: favorite?.name ?? "" })}. ${t("notify.newActivity")}`
                : t("fab.openFavorite", { name: favorite?.name ?? "" })
          }
          tabIndex={fanOpen ? 0 : -1}
          onClick={() => {
            select({ kind: "favorite", index });
            dispatch({ type: "dismiss" });
          }}
          style={{
            ...fanStyle(layout.favorites[index] ?? resting, index),
            width: FAVORITE_SIZE,
            height: FAVORITE_SIZE,
            margin: -FAVORITE_SIZE / 2,
          }}
          className={`fan-item fab-glass fixed z-20 grid place-items-center rounded-full text-lg font-medium text-white ${
            hover?.kind === "favorite" && hover.index === index ? "ring-2 ring-accent" : ""
          } ${locked ? "brightness-75 grayscale" : ""}`}
        >
          {favorite?.icon ? (
            <img src={favorite.icon} alt="" draggable={false} className="size-7 rounded-md" />
          ) : favorite ? (
            monogram(favorite.name)
          ) : (
            <ProIcon />
          )}
          {favorite && (
            <span
              className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-[11px] font-medium tracking-[0.14em] whitespace-nowrap text-white uppercase [text-shadow:0_1px_6px_rgb(0_0_0/0.7)] ${
                position.edge === "left"
                  ? "left-full ml-3 text-start rtl:text-end"
                  : "right-full mr-3 text-end rtl:text-start"
              }`}
            >
              {favorite.name}
            </span>
          )}
          {locked && favorite && (
            <span className="pro-badge absolute -end-1.5 -top-1.5 z-10 grid size-5 place-items-center rounded-full">
              <ProIcon size={12} />
            </span>
          )}
          {unread[index] > 0 && <UnreadBadge count={unread[index]} />}
        </button>
      ))}

      <button
        type="button"
        data-open={fanOpen}
        aria-label={t("fab.history")}
        tabIndex={fanOpen ? 0 : -1}
        onClick={() => {
          select({ kind: "history" });
          dispatch({ type: "dismiss" });
        }}
        style={{
          ...fanStyle(layout.history, list.length + 1),
          width: HISTORY_SIZE,
          height: HISTORY_SIZE,
          margin: -HISTORY_SIZE / 2,
        }}
        className={`fan-item fab-glass fixed z-20 grid place-items-center rounded-full ${
          hover?.kind === "history" ? "border-accent! text-accent" : "text-white"
        }`}
      >
        <HistoryIcon />
      </button>

      <button
        type="button"
        data-open={fanOpen}
        aria-label={t("fab.tabs")}
        tabIndex={fanOpen ? 0 : -1}
        onClick={() => {
          select({ kind: "tabs" });
          dispatch({ type: "dismiss" });
        }}
        style={{
          ...fanStyle(layout.tabs, list.length + 2),
          width: TABS_SIZE,
          height: TABS_SIZE,
          margin: -TABS_SIZE / 2,
        }}
        className={`fan-item fab-glass fixed z-20 grid place-items-center rounded-full ${
          hover?.kind === "tabs" ? "border-accent! text-accent" : "text-white"
        }`}
      >
        <TabsIcon />
      </button>

      <button
        type="button"
        data-open={fanOpen}
        aria-label={t("fab.usage")}
        tabIndex={fanOpen ? 0 : -1}
        onClick={() => {
          select({ kind: "stats" });
          dispatch({ type: "dismiss" });
        }}
        style={{
          ...fanStyle(layout.stats, list.length + 3),
          width: STATS_SIZE,
          height: STATS_SIZE,
          margin: -STATS_SIZE / 2,
        }}
        className={`fan-item fab-glass fixed z-20 grid place-items-center rounded-full ${
          hover?.kind === "stats" ? "border-accent! text-accent" : "text-white"
        }`}
      >
        <StatsIcon />
        {!isPro && (
          <span className="pro-badge absolute -end-1.5 -top-1.5 z-10 grid size-5 place-items-center rounded-full">
            <ProIcon size={12} />
          </span>
        )}
      </button>

      <button
        type="button"
        data-open={fanOpen}
        data-active={incognito.active}
        aria-label={t(incognito.active ? "fab.leaveIncognito" : "fab.incognito")}
        aria-pressed={incognito.active}
        aria-busy={incognito.busy}
        disabled={incognito.busy}
        tabIndex={fanOpen ? 0 : -1}
        onClick={() => {
          select({ kind: "incognito" });
          dispatch({ type: "dismiss" });
        }}
        style={{
          ...fanStyle(layout.incognito, list.length + 4),
          width: INCOGNITO_SIZE,
          height: INCOGNITO_SIZE,
          margin: -INCOGNITO_SIZE / 2,
        }}
        className={`fan-item fab-glass fixed z-20 grid place-items-center rounded-full ${
          hover?.kind === "incognito" ? "border-accent!" : ""
        } ${incognito.active ? "" : "text-white"} ${incognito.busy ? "animate-pulse" : ""}`}
      >
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
        {incognito.active && (
          <span
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-[11px] font-medium tracking-[0.14em] whitespace-nowrap text-white uppercase [text-shadow:0_1px_6px_rgb(0_0_0/0.7)] ${
              position.edge === "left"
                ? "left-full ml-3 text-start rtl:text-end"
                : "right-full mr-3 text-end rtl:text-start"
            }`}
          >
            {t("fab.leaveIncognitoHint")}
          </span>
        )}
      </button>

      <button
        type="button"
        data-open={fanOpen}
        data-active={controlsOn}
        aria-label={t("fab.videoControls")}
        aria-pressed={controlsOn}
        tabIndex={fanOpen ? 0 : -1}
        data-hold={controlsCharging ? "charging" : "idle"}
        onPointerDown={() => {
          controlsHeld.current = false;
          setControlsCharging(true);
          controlsHold.current = window.setTimeout(() => {
            controlsHeld.current = true;
            setControlsCharging(false);
            openSheet("video-controls");
            dispatch({ type: "dismiss" });
          }, HOLD_MS);
        }}
        onPointerUp={stopControlsHold}
        onPointerLeave={stopControlsHold}
        onPointerCancel={stopControlsHold}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => {
          if (controlsHeld.current) {
            controlsHeld.current = false;
            return;
          }
          select({ kind: "controls" });
          dispatch({ type: "dismiss" });
        }}
        style={{
          ...fanStyle(layout.controls, list.length + 5),
          width: CONTROLS_SIZE,
          height: CONTROLS_SIZE,
          margin: -CONTROLS_SIZE / 2,
          touchAction: "none",
        }}
        className={`fan-item fab-glass fixed z-20 grid place-items-center rounded-full ${
          hover?.kind === "controls" ? "border-accent! text-accent" : "text-white"
        }`}
      >
        <VideoControlsIcon on={controlsOn} />
        <svg className="fab-ring" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="31" pathLength="1" />
        </svg>
      </button>

      <button
        type="button"
        data-open={fanOpen}
        aria-label={t("fab.settings")}
        tabIndex={fanOpen ? 0 : -1}
        onClick={() => {
          select({ kind: "settings" });
          dispatch({ type: "dismiss" });
        }}
        style={{
          ...fanStyle(layout.settings, list.length),
          width: SETTINGS_SIZE,
          height: SETTINGS_SIZE,
          margin: -SETTINGS_SIZE / 2,
        }}
        className={`fan-item fab-glass fixed z-20 grid place-items-center rounded-full ${
          hover?.kind === "settings" ? "border-accent! text-accent" : "text-white"
        }`}
      >
        <SlidersIcon />
      </button>

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
