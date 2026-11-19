import { useEffect } from "react";
import { siteView, type Rect } from "../shared/ipc";
import { createRegionReporter } from "./regionReporter";

const TOUCH_PADDING = 8;

/** What `data-hit="tight"` asks for: the element's own box, with no padding round it. */
const TIGHT = "tight";

function measureRegions(): Rect[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-hit]")).flatMap((element) => {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return [];
    // A window's title strip and the handle between windows sit against a page, which must keep
    // every pixel of its own edge (its scroll bar included).
    const padding = element.dataset.hit === TIGHT ? 0 : TOUCH_PADDING;
    return [
      {
        x: box.x - padding,
        y: box.y - padding,
        width: box.width + 2 * padding,
        height: box.height + 2 * padding,
      },
    ];
  });
}

/**
 * The shell is transparent and sits above the site view. Touches inside `[data-hit]` elements
 * belong to the shell; everywhere else they fall through to the page. Native code needs those
 * rectangles, so report them whenever layout changes.
 */
export function useHitRegions() {
  useEffect(() => {
    let frame = 0;
    const reporter = createRegionReporter((regions) => siteView.setInteractiveRegions(regions));

    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => reporter.report(measureRegions()));
    };

    // The window may have been minimized or hidden while frames were not running: tell native
    // code again what the shell wants, whatever it last heard.
    const resync = () => {
      if (document.visibilityState !== "visible") return;
      reporter.forget();
      sync();
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    for (const type of ["resize", "transitionend", "transitioncancel", "animationend"]) {
      window.addEventListener(type, sync, true);
    }
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
      observer.disconnect();
      for (const type of ["resize", "transitionend", "transitioncancel", "animationend"]) {
        window.removeEventListener(type, sync, true);
      }
    };
  }, []);
}
