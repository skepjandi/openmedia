import { useEffect, useRef, type RefObject } from "react";
import { useApp } from "../../app/store";
import { idleSwipe, reduceWheel, type WheelSwipe } from "./trackpadSwipe";

/** On desktop, a two-finger trackpad swipe on one of the app's own pages calls `onBack`. */
export function useTrackpadSwipeBack(ref: RefObject<HTMLElement | null>, onBack: () => void) {
  const desktop = useApp((s) => s.desktop);
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    const element = ref.current;
    if (!desktop || !element) return;
    let state: WheelSwipe = idleSwipe;
    const onWheel = (event: WheelEvent) => {
      const step = reduceWheel(state, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        at: event.timeStamp,
        rtl: document.documentElement.dir === "rtl",
      });
      state = step.state;
      if (step.back) latest.current();
    };
    element.addEventListener("wheel", onWheel, { passive: true });
    return () => element.removeEventListener("wheel", onWheel);
  }, [desktop, ref]);
}
