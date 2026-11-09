import { useRef, useState, type PointerEvent } from "react";
import { selectPage, useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { BackIcon } from "../../shared/icons";
import { siteView } from "../../shared/ipc";
import { useInsets, useViewport } from "../../shared/viewport";
import { EDGE_MARGIN, snapToEdge, type Point } from "../fab/geometry";
import { backEdgeFor } from "../web/desktopLayout";
import { loadBackPosition, saveBackPosition, type BackPosition } from "./position";

const SIZE = 48;
const DRAG_THRESHOLD = 8;

interface Drag {
  pointerId: number;
  start: Point;
  moved: boolean;
}

/**
 * Optional floating back button (Settings, off by default). Shown only when the page can go back.
 * Tap: go back. Drag: move, then snap to the nearer edge. On desktop it stays in its own rail,
 * opposite the floating button.
 */
export function BackButton() {
  const enabled = useApp((s) => s.state?.backButton ?? false);
  const canGoBack = useApp((s) => selectPage(s)?.canGoBack ?? false);
  const sheet = useApp((s) => s.sheet);
  const onboardingOpen = useApp((s) => s.onboardingOpen);
  const desktop = useApp((s) => s.desktop);
  const fabEdge = useApp((s) => s.fabEdge);
  const reportError = useApp((s) => s.reportError);
  const t = useT();
  const viewport = useViewport();
  const insets = useInsets();
  const [position, setPosition] = useState<BackPosition>(loadBackPosition);
  const [dragCenter, setDragCenter] = useState<Point | null>(null);
  const drag = useRef<Drag | null>(null);

  if (!enabled || !canGoBack || sheet !== "none" || onboardingOpen) return null;

  const half = SIZE / 2;
  const edge = desktop ? backEdgeFor(fabEdge) : position.edge;
  const restingX = edge === "left" ? EDGE_MARGIN + half : viewport.width - EDGE_MARGIN - half;
  const minY = insets.top + EDGE_MARGIN + half;
  const maxY = viewport.height - insets.bottom - EDGE_MARGIN - half;
  const restingY = Math.min(Math.max(position.yRatio * viewport.height, minY), maxY);
  const center = dragCenter ?? { x: restingX, y: restingY };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      moved: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (desktop || !active || active.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - active.start.x, event.clientY - active.start.y);
    if (!active.moved && distance < DRAG_THRESHOLD) return;
    active.moved = true;
    setDragCenter({ x: event.clientX, y: event.clientY });
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!active.moved) {
      siteView.goBack().catch((error: unknown) => reportError(describeError(error, t)));
      return;
    }
    const snapped = snapToEdge({ x: event.clientX, y: event.clientY }, viewport, insets);
    const next = {
      edge: snapped.edge,
      yRatio: Math.min(Math.max(snapped.y / viewport.height, 0), 1),
    };
    setPosition(next);
    saveBackPosition(next);
    setDragCenter(null);
  };

  const onPointerCancel = () => {
    drag.current = null;
    setDragCenter(null);
  };

  return (
    <button
      type="button"
      data-hit=""
      aria-label={t("common.back")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        left: center.x - half,
        top: center.y - half,
        width: SIZE,
        height: SIZE,
        touchAction: "none",
      }}
      className="glass fixed z-10 grid place-items-center rounded-full text-paper"
    >
      <BackIcon />
    </button>
  );
}
