import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { SiteVideo, VideoControls } from "./ipc";
import { VIDEO_CONTROLS_DEFAULT } from "./videoControls";

const SOURCE = readFileSync(
  new URL("../../src-tauri/src/video_controls.js", import.meta.url),
  "utf8",
);

type Listener = (event: Record<string, unknown>) => void;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

class FakeVideo {
  localName = "video";
  nodeType = 1;
  isConnected = true;
  parentElement = null;
  loop = true;
  paused = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  duration = 20;
  currentTime = 0;
  scrolledIntoView = 0;
  box: Box;

  constructor(top = 0) {
    this.box = { top, left: 0, width: 400, height: 800, bottom: top + 800, right: 400 };
  }

  getBoundingClientRect() {
    return this.box;
  }

  scrollIntoView() {
    this.scrolledIntoView += 1;
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

class FakeElement {
  style = { cssText: "" } as Record<string, string>;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private text = "";
  /** The icon the page last put on this element, as its script records it. */
  __icon?: string;
  attributes: Record<string, string> = {};
  handlers = new Map<string, Listener[]>();

  get textContent() {
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
    if (value === "") this.children = [];
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
  }

  removeChild(child: FakeElement) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentNode = null;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  closest() {
    return null;
  }

  setPointerCapture() {}

  getBoundingClientRect() {
    return { top: 0, left: 0, width: 400, height: 4, bottom: 4, right: 400 };
  }

  addEventListener(type: string, handler: Listener) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  fire(type: string, event: Record<string, unknown> = {}) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler({
        type,
        pointerId: 1,
        stopPropagation() {},
        preventDefault() {},
        cancelable: true,
        ...event,
      });
    }
  }

  /** Every descendant, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

interface Tap {
  /** True when the page kept the tap from the site. */
  kept: boolean;
}

interface Page {
  body: FakeElement;
  storage: Map<string, string>;
  fire: (type: string, event?: Record<string, unknown>) => void;
  /** One 100 ms tick of the controls. */
  tick: () => void;
  /** A click at a point of the page, on a target that is not one of the site's buttons. */
  click: (x?: number, y?: number, target?: Record<string, unknown>) => Tap;
  /** A touch from one point to another, as a finger makes it; `kept` is true when the page took it. */
  touch: (from: [number, number], to?: [number, number], target?: Record<string, unknown>) => Tap;
  /** A pointer pressed and released, as a finger or mouse makes it before the touch or click. */
  pointer: (from: [number, number], to?: [number, number], target?: Record<string, unknown>) => Tap;
  /** Runs the timers the controls set, as when the panel's few seconds are up. */
  runTimers: () => void;
  /** What the feed player was told about a pause or a play the reader chose. */
  userPauses: Array<[FakeVideo, boolean]>;
  scrolls: Array<Record<string, unknown>>;
  setCalm: () => void;
  setCurrent: (video: FakeVideo | null) => void;
  teardown: () => void;
}

const SITE_BUTTON = { closest: (selector: string) => (selector.includes("button") ? {} : null) };
/** One transparent button over the whole video that catches taps, as Instagram's player has. */
const TAP_CATCHER = {
  closest: (selector: string) =>
    selector.includes("button")
      ? { getBoundingClientRect: () => ({ top: 0, left: 0, right: 400, bottom: 800 }) }
      : null,
};
const PANEL_PART = {
  closest: (selector: string) => (selector.includes("data-openmedia-controls") ? {} : null),
};
const PLAIN = { closest: () => null };

function load(options: {
  controls?: Partial<VideoControls>;
  sites?: Record<string, SiteVideo>;
  hostname?: string;
  /** False for a page the feed player does not know; default true. */
  feed?: boolean;
  /** The page's og:type, if it has one. */
  ogType?: string;
  pathname?: string;
  videos: FakeVideo[];
  current: FakeVideo | null;
  saved?: Record<string, unknown>;
}): Page {
  const intervals: Array<() => void> = [];
  const timeouts: Array<() => void> = [];
  const documentListeners = new Map<string, Listener[]>();
  const windowListeners = new Map<string, Listener[]>();
  const storage = new Map<string, string>();
  if (options.saved) storage.set("openmedia.video", JSON.stringify(options.saved));
  const body = new FakeElement();
  const scrolls: Array<Record<string, unknown>> = [];
  const userPauses: Array<[FakeVideo, boolean]> = [];
  let current = options.current;
  const document: Record<string | symbol, unknown> = {
    hidden: false,
    body,
    documentElement: body,
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
    querySelector: () =>
      options.ogType === undefined ? null : { getAttribute: () => options.ogType },
    querySelectorAll: () => ({
      forEach: (run: (video: FakeVideo) => void) => options.videos.forEach(run),
    }),
    addEventListener: (type: string, handler: Listener) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: Listener) => {
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? []).filter((candidate) => candidate !== handler),
      );
    },
  };
  document[Symbol.for("openmedia.isFeed")] = () => options.feed !== false;
  document[Symbol.for("openmedia.userPause")] = (video: FakeVideo, paused: boolean) =>
    userPauses.push([video, paused]);
  Object.defineProperty(document, Symbol.for("openmedia.currentVideo"), {
    get: () => current,
  });
  const win: Record<string, unknown> = {
    innerHeight: 800,
    innerWidth: 400,
    location: { hostname: options.hostname ?? "m.youtube.com", pathname: options.pathname ?? "/" },
    document,
    HTMLVideoElement: FakeVideo,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    PointerEvent: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    TouchEvent: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    Date,
    JSON,
    Math,
    Object,
    isFinite,
    getComputedStyle: () => ({ overflowY: "visible" }),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    setInterval: (run: () => void) => intervals.push(run),
    clearInterval: () => intervals.splice(0),
    setTimeout: (run: () => void) => timeouts.push(run),
    clearTimeout: () => timeouts.splice(0),
    addEventListener: (type: string, handler: Listener) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: Listener) => {
      windowListeners.set(
        type,
        (windowListeners.get(type) ?? []).filter((candidate) => candidate !== handler),
      );
    },
    scrollBy: (by: Record<string, unknown>) => scrolls.push(by),
  };
  win.window = win;
  win.top = win;
  const context = vm.createContext(win);
  const config = JSON.stringify({
    ...VIDEO_CONTROLS_DEFAULT,
    ...options.controls,
    sites: options.sites ?? {},
  });
  vm.runInContext(`(${SOURCE.trim().replace(/;$/, "")})(${config});`, context);

  return {
    body,
    storage,
    scrolls,
    userPauses,
    fire: (type, event = {}) => {
      for (const handler of documentListeners.get(type) ?? []) handler({ type, ...event });
    },
    tick: () => intervals.forEach((run) => run()),
    click: (x = 200, y = 400, target = PLAIN) => {
      const tap = { kept: false };
      for (const handler of windowListeners.get("click") ?? []) {
        handler({
          type: "click",
          clientX: x,
          clientY: y,
          target,
          cancelable: true,
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {
            tap.kept = true;
          },
        });
      }
      return tap;
    },
    touch: (from, to = from, target = PLAIN) => {
      const tap = { kept: false };
      for (const handler of windowListeners.get("touchstart") ?? []) {
        handler({ type: "touchstart", touches: [{ clientX: from[0], clientY: from[1] }], target });
      }
      for (const handler of windowListeners.get("touchend") ?? []) {
        handler({
          type: "touchend",
          changedTouches: [{ clientX: to[0], clientY: to[1] }],
          target,
          cancelable: true,
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {
            tap.kept = true;
          },
        });
      }
      return tap;
    },
    pointer: (from, to = from, target = PLAIN) => {
      const tap = { kept: false };
      for (const handler of windowListeners.get("pointerdown") ?? []) {
        handler({
          type: "pointerdown",
          clientX: from[0],
          clientY: from[1],
          isPrimary: true,
          target,
        });
      }
      for (const handler of windowListeners.get("pointerup") ?? []) {
        handler({
          type: "pointerup",
          clientX: to[0],
          clientY: to[1],
          pointerId: 1,
          pointerType: "touch",
          target,
          cancelable: true,
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {
            tap.kept = true;
          },
        });
      }
      return tap;
    },
    runTimers: () => timeouts.splice(0).forEach((run) => run()),
    setCalm: () => {
      document[Symbol.for("openmedia.noAutoplay")] = true;
    },
    setCurrent: (video) => {
      current = video;
    },
    teardown: () => (document[Symbol.for("openmedia.videoControls")] as () => void)(),
  };
}

function wideOpen(): Partial<VideoControls> {
  return { remember: true, loopOff: true, autoAdvance: true };
}

/** The panel's root once it is made, or undefined. */
function panelOf(page: Page) {
  return page.body.children[0];
}

function shown(page: Page): boolean {
  const root = panelOf(page);
  return root !== undefined && root.style.display === "block";
}

/** Taps the video and lets the panel come up. */
function openPanel(page: Page) {
  page.click();
  page.tick();
}

/** The panel's buttons by the icon they carry. */
function buttonWith(page: Page, icon: string) {
  const found = page.body.descendants().find((element) => element.__icon === icon);
  if (!found) throw new Error(`no button with the ${icon} icon`);
  return found;
}

function sliders(page: Page) {
  return page.body.descendants().filter((element) => element.handlers.has("pointermove"));
}

describe("video controls", () => {
  it("keeps a video from looping when it gets a new source", () => {
    const video = new FakeVideo();
    const page = load({ controls: { loopOff: true }, videos: [video], current: video });
    video.loop = true;
    page.fire("loadstart", { target: video });
    expect(video.loop).toBe(false);
  });

  it("leaves looping alone when it is not chosen", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    page.tick();
    expect(video.loop).toBe(true);
  });

  it("starts the next video at the speed the reader last chose", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video, saved: { rate: 1.5 } });
    page.fire("loadstart", { target: video });
    expect(video.playbackRate).toBe(1.5);
    expect(video.defaultPlaybackRate).toBe(1.5);
  });

  it("leaves the speed and sound of a page it is not in charge of alone", () => {
    const video = new FakeVideo();
    const page = load({
      controls: { remember: true },
      feed: false,
      pathname: "/watch",
      videos: [video],
      current: null,
      saved: { rate: 2, muted: true },
    });
    page.fire("loadstart", { target: video });
    expect(video.playbackRate).toBe(1);
    expect(video.muted).toBe(false);
  });

  it("stays hidden until the video is tapped, then shows and hides on a tap", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    page.tick();
    expect(shown(page)).toBe(false);

    expect(page.click().kept).toBe(true);
    page.tick();
    expect(shown(page)).toBe(true);

    expect(page.click().kept).toBe(true);
    page.tick();
    expect(shown(page)).toBe(false);
  });

  it("finds a tap from the touch when the player cancels the click, and swallows that click", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    expect(page.touch([200, 400]).kept).toBe(true);
    page.tick();
    expect(shown(page)).toBe(true);
    expect(page.click().kept).toBe(true);
    page.tick();
    expect(shown(page)).toBe(true);
  });

  it("tells the site the touch was cancelled when it keeps the tap, so no hold menu opens", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    const events: string[] = [];
    const target = {
      ...PLAIN,
      dispatchEvent: (event: { type: string }) => events.push(event.type),
    };
    expect(page.touch([200, 400], [200, 400], target).kept).toBe(true);
    expect(events).toEqual(["touchcancel"]);
  });

  it("keeps the pointer's release from the site, which mutes on it, and cancels the pointer", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    const events: string[] = [];
    const target = {
      ...PLAIN,
      dispatchEvent: (event: { type: string }) => events.push(event.type),
    };
    expect(page.pointer([200, 400], [200, 400], target).kept).toBe(true);
    expect(events).toEqual(["pointercancel"]);
    page.tick();
    expect(shown(page)).toBe(true);

    // The touch and the click that follow only get swallowed: the panel stays, nothing toggles.
    expect(page.touch([200, 400]).kept).toBe(true);
    expect(page.click().kept).toBe(true);
    page.tick();
    expect(shown(page)).toBe(true);
  });

  it("leaves a moved pointer, and one on a site button, to the site", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    expect(page.pointer([200, 600], [200, 150]).kept).toBe(false);
    expect(page.pointer([200, 400], [200, 400], SITE_BUTTON).kept).toBe(false);
    page.tick();
    expect(shown(page)).toBe(false);
  });

  it("leaves a swipe, and a touch on one of the site's buttons, to the site", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    expect(page.touch([200, 600], [200, 150]).kept).toBe(false);
    expect(page.touch([200, 400], [200, 400], SITE_BUTTON).kept).toBe(false);
    page.tick();
    expect(shown(page)).toBe(false);
  });

  it("leaves a tap on one of the site's own buttons, or off the video, to the site", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    expect(page.click(200, 400, SITE_BUTTON).kept).toBe(false);
    expect(page.click(200, 900).kept).toBe(false);
    page.tick();
    expect(shown(page)).toBe(false);
  });

  it("takes a tap on a transparent button the size of the video, which is the site's tap catcher", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    expect(page.touch([200, 400], [200, 400], TAP_CATCHER).kept).toBe(true);
    page.tick();
    expect(shown(page)).toBe(true);
  });

  it("catches a tap on the panel's blank parts, so it cannot reach a site button beneath", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const card = panelOf(page).children[0];
    expect(card.style.cssText).toContain("pointer-events:auto");
  });

  it("keeps a tap on its own panel from the site without closing it", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    page.click(200, 700, PANEL_PART);
    page.tick();
    expect(shown(page)).toBe(true);
  });

  it("pauses and plays the video and tells the feed player it was the reader's doing", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pause").fire("pointerup");
    expect(video.paused).toBe(true);
    page.tick();
    buttonWith(page, "play").fire("pointerup");
    expect(video.paused).toBe(false);
    expect(page.userPauses).toEqual([
      [video, true],
      [video, false],
    ]);
  });

  it("skips 6 seconds back and forward and stays inside the video", () => {
    const video = new FakeVideo();
    video.currentTime = 3;
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "back").fire("pointerup");
    expect(video.currentTime).toBe(0);
    buttonWith(page, "forward").fire("pointerup");
    expect(video.currentTime).toBe(6);
    video.currentTime = 18;
    buttonWith(page, "forward").fire("pointerup");
    expect(video.currentTime).toBe(20);
  });

  it("mutes and unmutes, and remembers the sound the reader chose", () => {
    const video = new FakeVideo();
    const page = load({ controls: { remember: true }, videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "sound").fire("pointerup");
    expect(video.muted).toBe(true);
    page.fire("volumechange", { target: video });
    expect(JSON.parse(page.storage.get("openmedia.video") ?? "{}").muted).toBe(true);
    page.tick();
    buttonWith(page, "muted").fire("pointerup");
    expect(video.muted).toBe(false);
  });

  it("has a mute button and no volume bar, which sites undo", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    expect(sliders(page)).toHaveLength(1);
  });

  it("leaves a page about one video, and its own controls, alone unless asked", () => {
    const watch = new FakeVideo();
    watch.box = { top: 100, left: 0, width: 400, height: 225, bottom: 325, right: 400 };
    const off = load({ feed: false, pathname: "/watch", videos: [watch], current: null });
    expect(off.click(200, 200).kept).toBe(false);
    expect(off.touch([200, 200]).kept).toBe(false);
  });

  it("works on a page about one video when full videos are on, for the app or for the site", () => {
    const watch = new FakeVideo();
    watch.box = { top: 100, left: 0, width: 400, height: 225, bottom: 325, right: 400 };
    const byType = load({
      controls: { fullVideos: true },
      feed: false,
      ogType: "video.other",
      videos: [watch],
      current: null,
    });
    expect(byType.click(200, 200).kept).toBe(true);
    byType.tick();
    expect(shown(byType)).toBe(true);

    const byPath = load({
      feed: false,
      pathname: "/watch",
      sites: { "youtube.com": { fullVideos: true } },
      videos: [watch],
      current: null,
    });
    expect(byPath.touch([200, 200]).kept).toBe(true);

    const siteOff = load({
      controls: { fullVideos: true },
      feed: false,
      pathname: "/watch",
      sites: { "youtube.com": { fullVideos: false } },
      videos: [watch],
      current: null,
    });
    expect(siteOff.click(200, 200).kept).toBe(false);
  });

  it("leaves other pages alone, and videos too small to be the page's video", () => {
    const watch = new FakeVideo();
    watch.box = { top: 100, left: 0, width: 400, height: 225, bottom: 325, right: 400 };
    const other = load({
      controls: { fullVideos: true },
      feed: false,
      pathname: "/home",
      videos: [watch],
      current: null,
    });
    expect(other.click(200, 200).kept).toBe(false);

    const tiny = new FakeVideo();
    tiny.box = { top: 100, left: 0, width: 100, height: 50, bottom: 150, right: 100 };
    const small = load({
      controls: { fullVideos: true },
      feed: false,
      pathname: "/watch",
      videos: [tiny],
      current: null,
    });
    expect(small.click(50, 120).kept).toBe(false);
  });

  it("steps through the speeds when the button is tapped and remembers the choice", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const [pill] = page.body.descendants().filter((element) => element.textContent.endsWith("×"));
    pill.fire("pointerup");
    expect(video.playbackRate).toBe(1.25);
    pill.fire("pointerup");
    expect(video.playbackRate).toBe(1.5);
    expect(JSON.parse(page.storage.get("openmedia.video") ?? "{}").rate).toBe(1.5);
  });

  it("seeks to where the bar is touched and shows the time left", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const track = sliders(page).at(-1);
    track?.fire("pointerdown", { clientX: 100 });
    expect(video.currentTime).toBe(5);
    track?.fire("pointermove", { clientX: 300 });
    expect(video.currentTime).toBe(15);
    page.fire("click");
    track?.fire("pointerup");
    page.tick();
    expect(page.body.descendants().some((element) => element.textContent === "-0:05")).toBe(true);
  });

  it("sits above the bottom edge and the home indicator by the height chosen for the site", () => {
    const video = new FakeVideo();
    const shared = load({ videos: [video], current: video });
    openPanel(shared);
    expect(panelOf(shared).style.bottom).toBe("calc(env(safe-area-inset-bottom,0px) + 16px)");

    const own = load({
      videos: [video],
      current: video,
      hostname: "m.youtube.com",
      sites: { "youtube.com": { height: 72 }, "instagram.com": { height: 120 } },
    });
    openPanel(own);
    expect(panelOf(own).style.bottom).toBe("calc(env(safe-area-inset-bottom,0px) + 72px)");

    const other = load({
      videos: [video],
      current: video,
      hostname: "www.notyoutube.com",
      sites: { "youtube.com": { height: 72 } },
    });
    openPanel(other);
    expect(panelOf(other).style.bottom).toBe("calc(env(safe-area-inset-bottom,0px) + 16px)");
  });

  it("gives a site its own controls back when the site, or the app, has the panel off", () => {
    const video = new FakeVideo();
    const siteOff = load({
      videos: [video],
      current: video,
      sites: { "youtube.com": { panel: false } },
    });
    expect(siteOff.click().kept).toBe(false);
    siteOff.tick();
    expect(shown(siteOff)).toBe(false);

    const appOff = load({ controls: { panel: false }, videos: [video], current: video });
    expect(appOff.click().kept).toBe(false);

    const siteOn = load({
      controls: { panel: false },
      videos: [video],
      current: video,
      sites: { "youtube.com": { panel: true } },
    });
    expect(siteOn.click().kept).toBe(true);
  });

  it("goes away when the video changes, and after a few seconds unless the video is paused", () => {
    const first = new FakeVideo();
    const next = new FakeVideo();
    const page = load({ videos: [first, next], current: first });
    openPanel(page);
    page.setCurrent(next);
    page.tick();
    expect(shown(page)).toBe(false);

    page.setCurrent(first);
    openPanel(page);
    first.paused = true;
    page.runTimers();
    page.tick();
    expect(shown(page)).toBe(true);
    first.paused = false;
    page.runTimers();
    page.tick();
    expect(shown(page)).toBe(false);
  });

  it("shows nothing when the page is not a feed or the video is not in view", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: null });
    expect(page.click().kept).toBe(false);
    page.tick();
    expect(shown(page)).toBe(false);
  });

  it("remembers sound only when the reader changed it", () => {
    const video = new FakeVideo();
    const page = load({ controls: { remember: true }, videos: [video], current: video });
    video.muted = true;
    page.fire("volumechange", { target: video });
    expect(page.storage.get("openmedia.video")).toBeUndefined();

    page.fire("touchend");
    page.fire("volumechange", { target: video });
    expect(JSON.parse(page.storage.get("openmedia.video") ?? "{}").muted).toBe(true);
  });

  it("scrolls to the next video when one ends, and never before it does", () => {
    const first = new FakeVideo(0);
    const next = new FakeVideo(800);
    const page = load({ controls: wideOpen(), videos: [first, next], current: first });
    page.tick();
    expect(next.scrolledIntoView).toBe(0);
    page.fire("ended", { target: first });
    expect(next.scrolledIntoView).toBe(1);
  });

  it("scrolls the page one screen when there is no next video in sight", () => {
    const only = new FakeVideo(0);
    const page = load({ controls: wideOpen(), videos: [only], current: only });
    page.fire("ended", { target: only });
    expect(page.scrolls).toEqual([{ top: 800, behavior: "smooth" }]);
  });

  it("does not move on unless the reader asked, and not in calm mode", () => {
    const first = new FakeVideo(0);
    const next = new FakeVideo(800);
    const off = load({ videos: [first, next], current: first });
    off.fire("ended", { target: first });
    expect(next.scrolledIntoView).toBe(0);

    const calm = load({ controls: wideOpen(), videos: [first, next], current: first });
    calm.setCalm();
    calm.fire("ended", { target: first });
    expect(next.scrolledIntoView).toBe(0);
  });

  it("removes its controls when it is replaced", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    expect(page.body.children).toHaveLength(1);
    page.teardown();
    expect(page.body.children).toHaveLength(0);
  });
});
