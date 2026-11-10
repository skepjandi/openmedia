import { useEffect, useRef, type RefObject } from "react";
import {
  backSide,
  commitsBack,
  inwardTravel,
  isBackDrag,
  startsAtEdge,
  type Side,
  type TouchPoint,
} from "./edgeSwipe";

const SETTLE_MS = 220;
const SETTLE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

interface Gesture {
  start: TouchPoint;
  side: Side;
  dragging: boolean;
  offset: number;
  velocity: number;
  lastX: number;
  lastAt: number;
}

/**
 * The iOS back gesture on the app's own full-screen pages: a swipe from the reading-side edge
 * drags the page along with the finger. Letting go far enough (or with a flick) slides it off and
 * calls `onBack`; otherwise it springs back. Pages in the site view keep the web view's own swipe;
 * this covers the shell.
 */
export function useEdgeSwipeBack(ref: RefObject<HTMLElement | null>, onBack: () => void) {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let gesture: Gesture | null = null;
    let settling = false;

    const place = (offset: number, side: Side) => {
      const signed = side === "left" ? offset : -offset;
      element.style.transform = `translate3d(${signed}px, 0, 0)`;
    };

    const settle = (offset: number, side: Side, done: () => void) => {
      settling = true;
      element.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASING}`;
      place(offset, side);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        element.removeEventListener("transitionend", finish);
        settling = false;
        done();
      };
      element.addEventListener("transitionend", finish);
      window.setTimeout(finish, SETTLE_MS + 80);
    };

    const reset = () => {
      element.style.transition = "";
      element.style.transform = "";
      element.style.boxShadow = "";
    };

    const begin = (event: TouchEvent) => {
      const touch = event.touches[0];
      const side = backSide(document.documentElement.dir);
      const onControl = event.target instanceof Element && event.target.closest("input, select");
      gesture =
        !settling &&
        event.touches.length === 1 &&
        touch &&
        !onControl &&
        startsAtEdge(touch.clientX, window.innerWidth, side)
          ? {
              start: { x: touch.clientX, y: touch.clientY },
              side,
              dragging: false,
              offset: 0,
              velocity: 0,
              lastX: touch.clientX,
              lastAt: event.timeStamp,
            }
          : null;
    };

    const track = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!gesture || !touch) return;
      const now = { x: touch.clientX, y: touch.clientY };
      if (!gesture.dragging) {
        if (!isBackDrag(gesture.start, now, gesture.side)) return;
        gesture.dragging = true;
        element.style.animation = "none";
        element.style.transition = "none";
        element.style.boxShadow = "0 0 32px rgb(0 0 0 / 0.35)";
      }
      if (event.cancelable) event.preventDefault();
      const elapsed = event.timeStamp - gesture.lastAt;
      if (elapsed > 0) {
        const moved =
          gesture.side === "left" ? touch.clientX - gesture.lastX : gesture.lastX - touch.clientX;
        gesture.velocity = moved / elapsed;
      }
      gesture.lastX = touch.clientX;
      gesture.lastAt = event.timeStamp;
      gesture.offset = Math.max(0, inwardTravel(gesture.start, now, gesture.side));
      place(gesture.offset, gesture.side);
    };

    const end = (event: TouchEvent) => {
      const current = gesture;
      gesture = null;
      if (!current?.dragging) return;
      const width = window.innerWidth;
      if (event.type === "touchend" && commitsBack(current.offset, current.velocity, width)) {
        settle(width, current.side, () => {
          latest.current();
          // A page that stays after Back (a step inside it) must not be left off screen.
          requestAnimationFrame(() => element.isConnected && reset());
        });
      } else {
        settle(0, current.side, reset);
      }
    };

    element.addEventListener("touchstart", begin, { passive: true });
    element.addEventListener("touchmove", track, { passive: false });
    element.addEventListener("touchend", end, { passive: true });
    element.addEventListener("touchcancel", end, { passive: true });
    return () => {
      element.removeEventListener("touchstart", begin);
      element.removeEventListener("touchmove", track);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", end);
    };
  }, [ref]);
}
