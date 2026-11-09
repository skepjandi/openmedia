import { useEffect, useState } from "react";
import { EDGE_MARGIN, FAB_SIZE, type Edge } from "../fab/geometry";

/**
 * On desktop the page is a view above the shell, so shell controls cannot float over it as they do
 * on mobile. The floating button (and the optional back button, on the other edge) rest in a
 * column beside the page instead, and docked panels push the page's edge in.
 */
export const RAIL_WIDTH = FAB_SIZE + 2 * EDGE_MARGIN;

/** Space beside the page, in pixels, for the shell's resting controls. */
export interface Rails {
  left: number;
  right: number;
}

export function railsFor(desktop: boolean, fabEdge: Edge, backButton: boolean): Rails {
  if (!desktop) return { left: 0, right: 0 };
  const backEdge: Edge = fabEdge === "left" ? "right" : "left";
  const reserved = (edge: Edge) => (edge === fabEdge || (backButton && edge === backEdge) ? 1 : 0);
  return { left: reserved("left") * RAIL_WIDTH, right: reserved("right") * RAIL_WIDTH };
}

/** The back button's edge: desktop keeps it opposite the floating button, in its own rail. */
export function backEdgeFor(fabEdge: Edge): Edge {
  return fabEdge === "left" ? "right" : "left";
}

/** Space a docked panel takes at the top or bottom of the window. */
export interface Reserve {
  top: number;
  bottom: number;
}

const NO_RESERVE: Reserve = { top: 0, bottom: 0 };
/** Gap kept between the page and a docked panel; matches the padding of the touch regions. */
const DOCK_GAP = 8;

interface DockBox {
  side: string | undefined;
  top: number;
  bottom: number;
}

/** What the visible docks take, measured from the window's edges. */
export function reserveFor(docks: DockBox[], viewportHeight: number): Reserve {
  let top = 0;
  let bottom = 0;
  for (const dock of docks) {
    if (dock.side === "top") top = Math.max(top, dock.bottom + DOCK_GAP);
    if (dock.side === "bottom") bottom = Math.max(bottom, viewportHeight - dock.top + DOCK_GAP);
  }
  return { top, bottom };
}

function measureDocks(): Reserve {
  const docks = Array.from(document.querySelectorAll<HTMLElement>("[data-dock]"))
    .map((element) => ({ side: element.dataset.dock, box: element.getBoundingClientRect() }))
    .filter(({ box }) => box.width > 0 && box.height > 0)
    .map(({ side, box }) => ({ side, top: box.top, bottom: box.bottom }));
  return reserveFor(docks, window.innerHeight);
}

/** Watches `[data-dock="top|bottom"]` panels and reports the room the page must leave for them. */
export function useDockReserve(enabled: boolean): Reserve {
  const [reserve, setReserve] = useState<Reserve>(NO_RESERVE);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const events = ["resize", "transitionend", "transitioncancel", "animationend"];
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measureDocks();
        setReserve((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
      });
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    events.forEach((type) => window.addEventListener(type, sync, true));
    sync();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      events.forEach((type) => window.removeEventListener(type, sync, true));
    };
  }, [enabled]);

  return enabled ? reserve : NO_RESERVE;
}
