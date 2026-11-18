import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { selectQuickFavorites, useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { CloseIcon } from "../../shared/icons";
import { displayHost } from "../../shared/favorites";
import { siteView, type Rect } from "../../shared/ipc";
import { useIconForUrl } from "../../shared/siteIcons";
import {
  beginTileDrag,
  currentDropTarget,
  registerDropMap,
  useTileDrag,
  type DropMap,
} from "./dragStore";
import { HEADER, dividers, paneRects, ratioAt, type Divider, type Drop } from "./layout";

/** How far a press on a window's title moves before it is a drag rather than a click. */
const DRAG_SLOP = 6;
/** How much wider than the gap a handle is, so it is easy to land on. */
const HANDLE_REACH = 3;

/** The slot's rectangle in window coordinates, kept up to date as the window or the page area changes. */
function useBounds(slot: RefObject<HTMLElement | null>): Rect | null {
  const [bounds, setBounds] = useState<Rect | null>(null);
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { x, y, width, height } = element.getBoundingClientRect();
        setBounds((current) =>
          current &&
          current.x === x &&
          current.y === y &&
          current.width === width &&
          current.height === height
            ? current
            : { x, y, width, height },
        );
      });
    };
    const observer = new ResizeObserver(read);
    observer.observe(element);
    window.addEventListener("resize", read);
    read();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [slot]);
  return bounds;
}

const shifted = (rect: Rect, by: { x: number; y: number }): Rect => ({
  ...rect,
  x: rect.x + by.x,
  y: rect.y + by.y,
});

/** What a window's page needs to be drawn: where its title strip ends and its page begins. */
function pageArea(window: Rect): Rect {
  return { ...window, y: window.y + HEADER, height: Math.max(window.height - HEADER, 1) };
}

/**
 * The windows of the desktop layout. The pages are native views under the shell; this layer
 * tells the native side where each goes, and draws what the shell owns: a title strip above each
 * window, the handles between them, a mark on the one in front, and, while a page is carried
 * over, where it would land.
 */
export function TileLayer({ slot }: { slot: RefObject<HTMLElement | null> }) {
  const layout = useApp((s) => s.layout);
  const activeId = useApp((s) => s.activeId);
  const showing = useApp((s) => s.activeId !== null && !s.blankTab);
  const bounds = useBounds(slot);
  const tiled = layout !== null && showing;

  const local = useMemo<Rect | null>(
    () => (bounds ? { x: 0, y: 0, width: bounds.width, height: bounds.height } : null),
    [bounds],
  );
  const windows = useMemo(
    () => (tiled && layout && local ? paneRects(layout, local) : null),
    [tiled, layout, local],
  );

  const sent = useRef("");
  useEffect(() => {
    if (!bounds) return;
    const panes = windows
      ? [...windows].map(([session, window]) => ({
          session,
          rect: shifted(pageArea(window), bounds),
        }))
      : [];
    const key = JSON.stringify(panes);
    if (key === sent.current) return;
    sent.current = key;
    void siteView.setLayout(panes).catch(() => {});
  }, [bounds, windows]);

  // Where a drop lands: the windows in window coordinates, or the whole page area while one page
  // (or none) fills it.
  useEffect(() => {
    if (!bounds || !local) {
      registerDropMap(null);
      return;
    }
    registerDropMap((): DropMap => {
      const page: Rect = bounds;
      let rects: Map<string, Rect> | null = null;
      if (windows) {
        rects = new Map([...windows].map(([id, window]) => [id, shifted(window, bounds)]));
      } else if (showing && activeId) {
        rects = new Map([[activeId, page]]);
      }
      return { page, windows: rects };
    });
    return () => registerDropMap(null);
  }, [bounds, local, windows, showing, activeId]);

  if (!bounds || !local) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {tiled && layout && windows && (
        <>
          {[...windows].map(([id, window]) => (
            <WindowTitle key={id} id={id} window={window} />
          ))}
          {dividers(layout, local).map((divider) => (
            <Handle key={divider.path.join(".")} divider={divider} origin={bounds} />
          ))}
          <FrontMark windows={windows} />
        </>
      )}
      <DropOverlay bounds={bounds} />
    </div>
  );
}

function FrontMark({ windows }: { windows: ReadonlyMap<string, Rect> }) {
  const activeId = useApp((s) => s.activeId);
  const window = activeId ? windows.get(activeId) : undefined;
  if (!window) return null;
  const area = pageArea(window);
  return (
    <div
      aria-hidden="true"
      style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
      className="pointer-events-none absolute rounded-b-md border-2 border-accent/70"
    />
  );
}

/** The strip above a window: its page, a click to bring it to the front, a drag to move it, a button to close it. */
function WindowTitle({ id, window }: { id: string; window: Rect }) {
  const t = useT();
  const session = useApp((s) => s.sessions.find((entry) => entry.id === id));
  const front = useApp((s) => s.activeId === id);
  const openSession = useApp((s) => s.openSession);
  const closeSession = useApp((s) => s.closeSession);
  const favorites = useApp(selectQuickFavorites);
  const url = session?.url ?? session?.openedUrl ?? "";
  const icon = useIconForUrl(url, favorites);
  const name = session?.title?.trim() || displayHost(url);
  const press = useRef<{ x: number; y: number; id: number } | null>(null);

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    press.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // capture is best-effort: the pointer may already be gone
    }
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const down = press.current;
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) <= DRAG_SLOP) return;
    press.current = null;
    beginTileDrag(event, { kind: "session", id }, name, icon);
  };
  const onUp = () => {
    if (press.current && !front) openSession(id);
    press.current = null;
  };

  return (
    <div
      data-hit="tight"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => (press.current = null)}
      style={{
        left: window.x,
        top: window.y,
        width: window.width,
        height: HEADER,
        touchAction: "none",
      }}
      className={`pointer-events-auto absolute flex items-center gap-1.5 overflow-hidden rounded-t-md border-b px-2 text-xs select-none ${
        front
          ? "border-accent/70 bg-ink text-paper"
          : "border-hair bg-ink/95 text-paper/60 hover:text-paper/85"
      }`}
    >
      {icon ? (
        <img src={icon} alt="" draggable={false} className="size-4 shrink-0 rounded-[4px]" />
      ) : (
        <span
          aria-hidden="true"
          className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-paper/15 text-[9px] leading-none font-semibold uppercase"
        >
          {name.charAt(0)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <button
        type="button"
        aria-label={t("tile.close", { name })}
        title={t("tile.close", { name })}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => closeSession(id)}
        className="grid size-5 shrink-0 place-items-center rounded-md text-paper/55 hover:bg-paper/10 hover:text-paper"
      >
        <span className="scale-[0.7]">
          <CloseIcon />
        </span>
      </button>
    </div>
  );
}

/** The handle in the gap between two windows: drag to resize them, double-click to even them out. */
function Handle({ divider, origin }: { divider: Divider; origin: Rect }) {
  const t = useT();
  const resizeSplit = useApp((s) => s.resizeSplit);
  const equalizeWindows = useApp((s) => s.equalizeWindows);
  const dragging = useRef(false);
  const row = divider.direction === "row";
  const { rect } = divider;
  const style = {
    left: rect.x - (row ? HANDLE_REACH : 0),
    top: rect.y - (row ? 0 : HANDLE_REACH),
    width: rect.width + (row ? 2 * HANDLE_REACH : 0),
    height: rect.height + (row ? 0 : 2 * HANDLE_REACH),
    touchAction: "none",
  };
  const to = (event: PointerEvent) => ({
    x: event.clientX - origin.x,
    y: event.clientY - origin.y,
  });

  return (
    <div
      data-hit="tight"
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={t("tile.resize")}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragging.current) resizeSplit(divider.path, ratioAt(divider, to(event)));
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onDoubleClick={equalizeWindows}
      style={style}
      className={`group pointer-events-auto absolute z-10 flex items-center justify-center ${
        row ? "cursor-col-resize" : "cursor-row-resize"
      }`}
    >
      <span
        aria-hidden="true"
        className={`rounded-full bg-hair transition-colors group-hover:bg-accent/70 group-active:bg-accent ${
          row ? "h-full w-[3px]" : "h-[3px] w-full"
        }`}
      />
    </div>
  );
}

const DROP_LABELS = {
  center: "tile.dropHere",
  left: "tile.dropLeft",
  right: "tile.dropRight",
  top: "tile.dropAbove",
  bottom: "tile.dropBelow",
} as const satisfies Record<Drop, MessageKey>;

/**
 * While a page is carried over the windows: a veil over the page area, the part of a window the
 * page would take, and the page itself at the pointer. The veil is a region of the shell, so the
 * pointer stays with the shell wherever it goes.
 */
function DropOverlay({ bounds }: { bounds: Rect }) {
  const t = useT();
  const drag = useTileDrag((s) => s.drag);
  if (!drag) return null;
  const landing = currentDropTarget(drag.point);
  const area = landing ? shifted(landing.area, { x: -bounds.x, y: -bounds.y }) : null;
  return (
    <>
      <div data-hit="" className="pointer-events-auto absolute inset-0 z-30 bg-black/25" />
      {area && landing && (
        <div
          aria-hidden="true"
          style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
          className="pointer-events-none absolute z-40 grid place-items-center rounded-lg border-2 border-accent bg-accent/25"
        >
          <span className="rounded-full bg-ink/85 px-3 py-1 text-xs font-medium text-paper">
            {t(drag.page.kind === "folder" ? "tile.dropFolder" : DROP_LABELS[landing.drop])}
          </span>
        </div>
      )}
      <div
        style={{ position: "fixed", left: drag.point.x + 12, top: drag.point.y + 12 }}
        className="pointer-events-none z-50 flex items-center gap-2 rounded-full border border-hair bg-ink/90 px-3 py-1.5 text-xs text-paper shadow-lg"
      >
        {drag.icon && <img src={drag.icon} alt="" className="size-4 rounded-[4px]" />}
        <span className="max-w-40 truncate">{drag.label}</span>
      </div>
    </>
  );
}
