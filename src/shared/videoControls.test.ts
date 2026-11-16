import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A video that sits in a page: it has a parent to leave and return to, a style and events. */
/** A video's inline style that counts the page's writes, and can be wiped of priorities by a site. */
class CountedStyle {
  writes = 0;
  wiped = false;
  private css = "";

  get cssText() {
    return this.css;
  }

  set cssText(value: string) {
    this.css = value;
    this.writes += 1;
    this.wiped = false;
  }

  getPropertyPriority() {
    return this.wiped ? "" : "important";
  }
}

class PlacedVideo extends FakeVideo {
  parentNode: FakeElement | null = null;
  videoWidth = 1280;
  videoHeight = 720;
  currentSrc = "blob:one";
  ended = false;
  style = new CountedStyle();
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<() => void>>();

  getAttribute(name: string) {
    if (name === "style" && this.style.cssText === "") return null;
    return name === "style" ? this.style.cssText : (this.attrs.get(name) ?? null);
  }

  setAttribute(name: string, value: string) {
    if (name === "style") this.style.cssText = value;
    else this.attrs.set(name, value);
  }

  removeAttribute(name: string) {
    if (name === "style") this.style.cssText = "";
    else this.attrs.delete(name);
  }

  addEventListener(type: string, handler: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  removeEventListener(type: string, handler: () => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== handler),
    );
  }

  emit(type: string) {
    for (const handler of this.listeners.get(type) ?? []) handler();
  }

  descendants() {
    return [];
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0);
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
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
  }

  insertBefore(child: FakeElement, before: FakeElement) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(before), 0, child);
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

/** A frame of the page: another site's player, which the page cannot reach into. */
class FakeFrame extends FakeElement {
  isConnected = true;
  sent: unknown[] = [];
  contentWindow = { postMessage: (message: unknown) => this.sent.push(message) };
  styles = new Map<string, string>();
  constructor() {
    super();
    this.style = {
      cssText: "",
      setProperty: (name: string, value: string) => this.styles.set(name, value),
    } as unknown as Record<string, string>;
  }
  getAttribute() {
    return null;
  }
  removeAttribute() {}
  getBoundingClientRect() {
    return { top: 100, left: 0, width: 400, height: 225, bottom: 325, right: 400 };
  }
}

interface Tap {
  /** True when the page kept the tap from the site. */
  kept: boolean;
  /** True when the page kept the press (the pointer going down) from the site. */
  pressKept?: boolean;
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
  /** What sits under a point of the page, top first: the elements `elementsFromPoint` answers. */
  stack: (elements: unknown[]) => void;
  pointer: (from: [number, number], to?: [number, number], target?: Record<string, unknown>) => Tap;
  /** A pointer tap where `between` runs after the press and before the release. */
  pointerWith: (at: [number, number], between: () => void) => Tap;
  /** Fires one event at the page's window listeners; true when a listener kept it from the site. */
  win: (type: string, event?: Record<string, unknown>) => boolean;
  /** Runs the timers the controls set, as when the panel's few seconds are up. */
  runTimers: () => void;
  /** What the feed player was told about a pause or a play the reader chose. */
  userPauses: Array<[FakeVideo, boolean]>;
  scrolls: Array<Record<string, unknown>>;
  setCalm: () => void;
  setCurrent: (video: FakeVideo | null) => void;
  teardown: () => void;
  /** What the page told the app about the small player. */
  posts: unknown[];
  /** What a frame told its page. */
  parentPosts: unknown[];
  /** The page the frame is in, as the source of its messages. */
  parent: unknown;
  /** The page's document, for what the controls leave on it. */
  document: Record<string | symbol, unknown>;
  /** Callbacks of the mutation observers the controls made, as the browser would call them. */
  observers: Array<() => void>;
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
  /** True when the script runs inside a frame of the page, as another site's player does. */
  frame?: boolean;
  /** The frames the page has. */
  frames?: FakeFrame[];
  videos: FakeVideo[];
  current: FakeVideo | null;
  saved?: Record<string, unknown>;
}): Page {
  const intervals: Array<() => void> = [];
  const timeouts = new Map<number, () => void>();
  const observers: Array<() => void> = [];
  const posts: unknown[] = [];
  let timeoutId = 0;
  const documentListeners = new Map<string, Listener[]>();
  const windowListeners = new Map<string, Listener[]>();
  const storage = new Map<string, string>();
  if (options.saved) storage.set("openmedia.video", JSON.stringify(options.saved));
  const body = new FakeElement();
  const scrolls: Array<Record<string, unknown>> = [];
  const userPauses: Array<[FakeVideo, boolean]> = [];
  let current = options.current;
  let stack: unknown[] = [];
  const document: Record<string | symbol, unknown> = {
    hidden: false,
    body,
    documentElement: body,
    getElementById: () => null,
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
    createComment: () => new FakeElement(),
    querySelector: () =>
      options.ogType === undefined ? null : { getAttribute: () => options.ogType },
    querySelectorAll: (selector: string) =>
      selector === "video"
        ? options.videos
        : selector === "iframe"
          ? (options.frames ?? [])
          : stack,
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
      constructor(callback: () => void) {
        observers.push(callback);
      }
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
    setTimeout: (run: () => void) => {
      timeoutId += 1;
      timeouts.set(timeoutId, run);
      return timeoutId;
    },
    clearTimeout: (id: number) => timeouts.delete(id),
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
    webkit: {
      messageHandlers: { openmediaMini: { postMessage: (body: unknown) => posts.push(body) } },
    },
  };
  win.window = win;
  const parentPosts: unknown[] = [];
  const parent = { postMessage: (message: unknown) => parentPosts.push(message) };
  win.parent = parent;
  win.screen = { width: 400, height: 800 };
  win.top = options.frame ? parent : win;
  win.__parent = parent;
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
    stack: (elements) => {
      stack = elements;
    },
    pointer: (from, to = from, target = PLAIN) => {
      const tap: Tap = { kept: false };
      for (const handler of windowListeners.get("pointerdown") ?? []) {
        handler({
          type: "pointerdown",
          clientX: from[0],
          clientY: from[1],
          isPrimary: true,
          target,
          stopImmediatePropagation() {
            tap.pressKept = true;
          },
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
    pointerWith: (at, between) => {
      const tap = { kept: false };
      for (const handler of windowListeners.get("pointerdown") ?? []) {
        handler({
          type: "pointerdown",
          clientX: at[0],
          clientY: at[1],
          isPrimary: true,
          target: PLAIN,
          stopImmediatePropagation() {},
        });
      }
      between();
      for (const handler of windowListeners.get("pointerup") ?? []) {
        handler({
          type: "pointerup",
          clientX: at[0],
          clientY: at[1],
          pointerId: 1,
          pointerType: "touch",
          target: PLAIN,
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
    win: (type, event = {}) => {
      let kept = false;
      for (const handler of windowListeners.get(type) ?? []) {
        handler({
          type,
          cancelable: true,
          target: PLAIN,
          isPrimary: true,
          pointerId: 1,
          pointerType: "touch",
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {
            kept = true;
          },
          ...event,
        });
      }
      return kept;
    },
    runTimers: () => {
      const due = [...timeouts.values()];
      timeouts.clear();
      due.forEach((run) => run());
    },
    setCalm: () => {
      document[Symbol.for("openmedia.noAutoplay")] = true;
    },
    setCurrent: (video) => {
      current = video;
    },
    teardown: () => (document[Symbol.for("openmedia.videoControls")] as () => void)(),
    observers,
    posts,
    parentPosts,
    parent,
    document,
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

    // The touch and the click that follow only get swallowed, once. The touch began before the
    // pointer went up, as it does on a phone.
    const second = load({ videos: [video], current: video });
    second.win("pointerdown", { clientX: 200, clientY: 400, target });
    second.win("touchstart", { touches: [{ clientX: 200, clientY: 400 }], target });
    expect(second.win("pointerup", { clientX: 200, clientY: 400, target })).toBe(true);
    expect(
      second.win("touchend", { changedTouches: [{ clientX: 200, clientY: 400 }], target }),
    ).toBe(true);
    expect(second.win("click", { clientX: 200, clientY: 400, target })).toBe(true);
    // Only once: the next click is the site's again.
    expect(second.win("click", { clientX: 200, clientY: 900, target })).toBe(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides a small icon at the video's centre after a press on it, then gives it back", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    const style = new Map<string, string>();
    const icon = {
      closest: (selector: string) => (selector.includes("button") ? {} : null),
      matches: () => false,
      contains: () => false,
      parentElement: null,
      getBoundingClientRect: () => ({
        top: 380,
        left: 165,
        right: 235,
        bottom: 450,
        width: 70,
        height: 70,
      }),
      style: {
        getPropertyValue: (name: string) => style.get(name) ?? "",
        getPropertyPriority: () => "",
        setProperty: (name: string, value: string) => style.set(name, value),
        removeProperty: (name: string) => style.delete(name),
      },
    };
    const big = {
      closest: () => null,
      matches: () => false,
      contains: () => false,
      parentElement: null,
      getBoundingClientRect: () => ({
        top: 0,
        left: 0,
        right: 400,
        bottom: 800,
        width: 400,
        height: 800,
      }),
      style: { ...icon.style, setProperty: () => expect.unreachable("a big element was hidden") },
    };
    page.stack([big, icon]);
    page.win("pointerdown", { clientX: 200, clientY: 400 });
    expect(style.get("opacity")).toBe("0");
    expect(style.get("visibility")).toBe("hidden");
    // The cancel this script sends the site after a tap is not the browser's: nothing is given back.
    page.win("pointercancel", { isTrusted: false });
    expect(style.get("opacity")).toBe("0");
    vi.setSystemTime(Date.now() + 2000);
    page.runTimers();
    expect(style.has("opacity")).toBe(false);
    expect(style.has("visibility")).toBe(false);
  });

  it("stops hiding at once when the press turns into a swipe", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    const style = new Map<string, string>();
    const icon = {
      closest: () => null,
      matches: () => false,
      contains: () => false,
      getBoundingClientRect: () => ({
        top: 380,
        left: 165,
        right: 235,
        bottom: 450,
        width: 70,
        height: 70,
      }),
      style: {
        getPropertyValue: (name: string) => style.get(name) ?? "",
        getPropertyPriority: () => "",
        setProperty: (name: string, value: string) => style.set(name, value),
        removeProperty: (name: string) => style.delete(name),
      },
    };
    page.stack([icon]);
    page.win("pointerdown", { clientX: 200, clientY: 600 });
    expect(style.get("opacity")).toBe("0");
    page.win("pointermove", { clientX: 200, clientY: 300 });
    expect(style.has("opacity")).toBe(false);
    page.runTimers();
    expect(style.has("opacity")).toBe(false);
  });

  it("takes the video full screen with the panel's button, in the phone's own player when there is one", () => {
    const video = new FakeVideo() as FakeVideo & {
      webkitEnterFullscreen?: () => void;
      requestFullscreen?: () => void;
    };
    const entered: string[] = [];
    video.webkitEnterFullscreen = () => entered.push("webkit");
    video.requestFullscreen = () => entered.push("standard");
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "fullscreen").fire("pointerup");
    expect(entered).toEqual(["webkit"]);

    const plain = new FakeVideo() as FakeVideo & { requestFullscreen?: () => void };
    plain.requestFullscreen = () => entered.push("standard");
    const other = load({ videos: [plain], current: plain });
    openPanel(other);
    buttonWith(other, "fullscreen").fire("pointerup");
    expect(entered).toEqual(["webkit", "standard"]);
  });

  it("counts a frame or video that is off the screen as no area, not a positive one", () => {
    const hidden = new FakeFrame();
    hidden.getBoundingClientRect = () => ({
      top: -1000,
      left: -1000,
      width: 0,
      height: 0,
      bottom: -1000,
      right: -1000,
    });
    const page = load({ feed: false, videos: [], current: null, frames: [hidden], pathname: "/x" });
    page.tick();
    page.win("touchstart", { touches: [{ clientX: 10, clientY: 10 }], target: PLAIN });
    expect(page.win("touchmove", { touches: [{ clientX: 10, clientY: 60 }] })).toBe(false);
    expect(page.document[Symbol.for("openmedia.holdRefresh")]).toBeFalsy();
  });

  it("lifts the video into a small player in the corner and puts it back with its close button", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    expect(box).toBeDefined();
    expect(video.parentNode).toBe(box);
    expect(box?.style.cssText).toContain("right:12px");
    expect(box?.style.cssText).toContain("bottom:96px");
    expect(video.style.cssText).toContain("width:100%!important");
    page.tick();
    expect(shown(page)).toBe(false);

    // The box's own close button puts it back.
    const close = box?.children.find((child) => child.__icon === "close");
    close?.fire("pointerup");
    expect(video.parentNode).toBe(home);
    expect(page.body.children.includes(box as FakeElement)).toBe(false);
    expect(video.style.cssText).toBe("");
    expect(video.listenerCount()).toBe(0);
  });

  it("asks the app to move the page to the corner when the player goes up, and not when it comes down", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    expect(page.posts).toEqual([true, { float: true }]);
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    box?.children.find((child) => child.__icon === "close")?.fire("pointerup");
    expect(page.posts).toEqual([true, { float: true }, false]);
  });

  it("asks the app to put the page back as it was from the player's expand button", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    box?.children.find((child) => child.__icon === "expand")?.fire("pointerup");
    expect(page.posts).toContainEqual({ expand: true });
    // The page's own copy of the player stays up until the app answers.
    expect(video.parentNode).toBe(box);
  });

  it("keeps playing when the site pauses its video, and pauses only from its own button", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    // A feed pausing what it thinks is out of view.
    video.pause();
    expect(video.paused).toBe(false);
    // A pause that goes round the page's own method is undone a moment later.
    FakeVideo.prototype.pause.call(video);
    video.emit("pause");
    expect(video.paused).toBe(true);
    page.runTimers();
    expect(video.paused).toBe(false);
    // The reader's pause stays, and so does the play after it.
    const toggle = () =>
      box?.children.find((child) => child.__icon === "pause" || child.__icon === "play");
    toggle()?.fire("pointerup");
    expect(video.paused).toBe(true);
    video.emit("pause");
    page.runTimers();
    expect(video.paused).toBe(true);
    toggle()?.fire("pointerup");
    expect(video.paused).toBe(false);
    // Closed, the page's own pause works again.
    box?.children.find((child) => child.__icon === "close")?.fire("pointerup");
    video.pause();
    expect(video.paused).toBe(true);
  });

  it("does not let the click after a button press reach the page that is under the finger now", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    // The click that follows the release, on whatever is there now.
    expect(page.win("click", { target: { closest: () => null }, clientX: 200, clientY: 700 })).toBe(
      true,
    );
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    box?.children.find((child) => child.__icon === "close")?.fire("pointerup");
    expect(video.parentNode).toBe(home);
    expect(page.win("click", { target: { closest: () => null }, clientX: 540, clientY: 700 })).toBe(
      true,
    );
  });

  describe("dragging the player down on a watch page", () => {
    // A drag's speed is taken from the clock: a still clock makes it nothing, not a flick.
    beforeEach(() => {
      vi.spyOn(Date, "now").mockReturnValue(1000);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const watch = () => {
      const home = new FakeElement();
      const video = new PlacedVideo();
      home.appendChild(video as unknown as FakeElement);
      const page = load({ videos: [video], current: video, pathname: "/watch", feed: false });
      return { home, video, page };
    };
    const touch = (y: number, x = 200) => ({ touches: [{ clientX: x, clientY: y }] });
    const miniBox = (page: Page) =>
      page.body.children.find((child) => "data-openmedia-mini" in child.attributes);

    it("shrinks the video into the small player as the finger goes, and keeps it past the halfway", () => {
      const { video, page } = watch();
      page.win("touchstart", touch(100));
      page.win("touchmove", touch(130));
      const box = miniBox(page);
      expect(box).toBeDefined();
      expect(video.parentNode).toBe(box);
      const early = Number.parseInt(box?.style.width ?? "0");
      page.win("touchmove", touch(300));
      const later = Number.parseInt(box?.style.width ?? "0");
      expect(later).toBeLessThan(early);
      expect(page.win("touchend", touch(300))).toBe(true);
      page.runTimers();
      expect(page.posts).toContainEqual({ float: true });
      expect(video.parentNode).toBe(box);
    });

    it("keeps the speed the video had when the site's press and hold sets double speed during the drag", () => {
      const { video, page } = watch();
      page.win("touchstart", touch(100));
      page.win("touchmove", touch(140));
      video.playbackRate = 2;
      video.emit("ratechange");
      expect(video.playbackRate).toBe(1);
      page.win("touchmove", touch(300));
      page.win("touchend", touch(300));
      video.playbackRate = 2;
      video.emit("ratechange");
      expect(video.playbackRate).toBe(1);
      page.runTimers();
      video.playbackRate = 2;
      video.emit("ratechange");
      expect(video.playbackRate).toBe(2);
    });

    it("puts the video back when let go short of the way", () => {
      const { home, video, page } = watch();
      page.win("touchstart", touch(100));
      page.win("touchmove", touch(140));
      page.win("touchend", touch(140));
      page.runTimers();
      expect(video.parentNode).toBe(home);
      expect(page.posts).not.toContainEqual({ float: true });
    });

    it("keeps it for a quick flick", () => {
      const { video, page } = watch();
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      page.win("touchstart", touch(100));
      now += 10;
      page.win("touchmove", touch(112));
      now += 20;
      page.win("touchmove", touch(150));
      page.win("touchend", touch(150));
      page.runTimers();
      expect(page.posts).toContainEqual({ float: true });
      expect(video.parentNode).not.toBeNull();
      vi.restoreAllMocks();
    });

    it("leaves a sideways drag (a seek) and a drag up (a scroll) to the site", () => {
      const sideways = watch();
      sideways.page.win("touchstart", touch(100, 100));
      expect(sideways.page.win("touchmove", touch(120, 220))).toBe(false);
      expect(miniBox(sideways.page)).toBeUndefined();
      const up = watch();
      up.page.win("touchstart", touch(300));
      expect(up.page.win("touchmove", touch(200))).toBe(false);
      expect(up.page.win("touchmove", touch(400))).toBe(false);
      expect(miniBox(up.page)).toBeUndefined();
    });

    it("tells the app's pull to refresh in advance that the page counts as scrolled", () => {
      const { page } = watch();
      page.tick();
      expect(page.posts).toEqual([]);
      const held = () =>
        (page.document as Record<symbol, unknown>)[Symbol.for("openmedia.holdRefresh")];
      expect(held()).toBe(true);
      const video = new PlacedVideo();
      const feed = load({ videos: [video], current: video, feed: true, pathname: "/watch" });
      feed.tick();
      expect(
        (feed.document as Record<symbol, unknown>)[Symbol.for("openmedia.holdRefresh")],
      ).toBeFalsy();
    });

    it("in a frame, asks the page and never the app, and drags once the page says yes", () => {
      const video = new PlacedVideo();
      const page = load({
        frame: true,
        feed: false,
        videos: [video],
        current: video,
        pathname: "/embed/one",
      });
      const touch = (y: number) => ({
        touches: [{ clientX: 200, clientY: y, screenX: 200, screenY: y }],
      });
      page.win("touchstart", touch(100));
      expect(page.parentPosts).toEqual([{ om: "drag-start" }]);
      // Until the page answers, a drag down is the site's.
      expect(page.win("touchmove", touch(160))).toBe(false);
      page.win("message", { source: page.parent, data: { om: "drag-ok", ok: true } });
      expect(page.win("touchmove", touch(200))).toBe(true);
      expect(page.parentPosts).toContainEqual({ om: "drag-move", dy: 100 });
      page.win("touchend", touch(200));
      expect(page.parentPosts.at(-1)).toMatchObject({ om: "drag-end", cancelled: false });
      expect(page.posts).toEqual([]);
    });

    it("in a frame, ignores what is not from its page and shows no panel once the page has made it the small player", () => {
      const video = new PlacedVideo();
      const page = load({
        frame: true,
        feed: false,
        videos: [video],
        current: video,
        pathname: "/embed/one",
      });
      page.win("message", { source: {}, data: { om: "drag-ok", ok: true } });
      page.win("message", { source: page.parent, data: { om: "mini", on: true } });
      page.win("touchstart", {
        touches: [{ clientX: 200, clientY: 100, screenX: 200, screenY: 100 }],
      });
      expect(page.parentPosts).toEqual([]);
    });

    it("moves a frame the page has to the corner when its player is dragged down, and the app is told by the page", () => {
      const frame = new FakeFrame();
      const home = new FakeElement();
      home.appendChild(frame);
      const page = load({
        feed: false,
        videos: [],
        current: null,
        frames: [frame],
        pathname: "/watch/one",
      });
      const frameMessage = (data: Record<string, unknown>) =>
        page.win("message", { source: frame.contentWindow, data: { om: "x", ...data } });
      frameMessage({ om: "drag-start" });
      expect(frame.sent).toContainEqual({ om: "drag-ok", ok: true });
      frameMessage({ om: "drag-move", dy: 300 });
      expect(frame.styles.get("position")).toBe("fixed");
      expect(
        page.body.descendants().some((child) => "data-openmedia-mini" in child.attributes),
      ).toBe(true);
      frameMessage({ om: "drag-end", speed: 0, cancelled: false });
      page.runTimers();
      expect(page.posts).toContainEqual({ float: true });
      expect(frame.sent).toContainEqual({ om: "mini", on: true });
    });

    it("puts a frame back when its drag is let go short of the way", () => {
      const frame = new FakeFrame();
      const home = new FakeElement();
      home.appendChild(frame);
      const page = load({
        feed: false,
        videos: [],
        current: null,
        frames: [frame],
        pathname: "/watch/one",
      });
      const frameMessage = (data: Record<string, unknown>) =>
        page.win("message", { source: frame.contentWindow, data });
      frameMessage({ om: "drag-start" });
      frameMessage({ om: "drag-move", dy: 40 });
      frameMessage({ om: "drag-end", speed: 0, cancelled: false });
      page.runTimers();
      expect(page.posts).not.toContainEqual({ float: true });
      expect(frame.sent).toContainEqual({ om: "mini", on: false });
      expect(home.children).toContain(frame);
    });

    it("does nothing in a feed, where the swipe is the way to the next video", () => {
      const video = new PlacedVideo();
      const feed = load({ videos: [video], current: video, feed: true, pathname: "/watch" });
      feed.win("touchstart", touch(100));
      expect(feed.win("touchmove", touch(300))).toBe(false);
      expect(miniBox(feed)).toBeUndefined();
    });
  });

  it("closes a small player whose video the site's player took out of the box", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    box?.removeChild(video as unknown as FakeElement);
    video.parentNode = null;
    page.tick();
    expect(page.body.children.includes(box as FakeElement)).toBe(false);
  });

  it("keeps playing a video that was playing, and pauses and plays from its own button", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    const toggle = box?.children.find((child) => child.__icon === "pause");
    expect(video.paused).toBe(false);
    toggle?.fire("pointerup");
    expect(video.paused).toBe(true);
    toggle?.fire("pointerup");
    expect(video.paused).toBe(false);
  });

  it("is dragged by a finger on the box, inside the screen", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    box?.fire("pointerdown", { clientX: 300, clientY: 600 });
    box?.fire("pointermove", { clientX: 200, clientY: 500 });
    expect(box?.style.right).toBe("112px");
    expect(box?.style.bottom).toBe("196px");
    box?.fire("pointermove", { clientX: -5000, clientY: -5000 });
    expect(Number.parseInt(box?.style.right ?? "")).toBeLessThanOrEqual(400);
    expect(Number.parseInt(box?.style.bottom ?? "")).toBeLessThanOrEqual(800);
    box?.fire("pointerup");
  });

  it("ends with the video, and when the site loads another into the same player", () => {
    for (const ending of ["ended", "loadstart"]) {
      const home = new FakeElement();
      const video = new PlacedVideo();
      home.appendChild(video as unknown as FakeElement);
      const page = load({ videos: [video], current: video });
      openPanel(page);
      buttonWith(page, "pip").fire("pointerup");
      if (ending === "loadstart") video.currentSrc = "blob:two";
      video.emit(ending);
      expect(video.parentNode).toBe(home);
    }
  });

  it("answers a site that keeps restyling the lifted video a limited number of times, not without end", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const before = video.style.writes;
    for (let round = 0; round < 500; round += 1) {
      video.style.wiped = true;
      for (const callback of page.observers) callback();
      page.runTimers();
    }
    expect(video.style.writes - before).toBeGreaterThan(0);
    expect(video.style.writes - before).toBeLessThanOrEqual(40);
  });

  it("does not end for a load of the same video", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    video.emit("loadstart");
    expect(video.parentNode).not.toBe(home);
  });

  it("puts the video back when the controls are torn down", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    page.teardown();
    expect(video.parentNode).toBe(home);
  });

  it("keeps a touch on the small player from the site", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    const part = {
      closest: (selector: string) => (selector.includes("data-openmedia-mini") ? {} : null),
    };
    expect(page.win("touchstart", { target: part })).toBe(true);
  });

  it("always shows the site the press, so a drag or a swipe reaches it whole", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    expect(page.pointer([200, 400]).pressKept).toBeUndefined();
    expect(page.win("pointerdown", { clientX: 200, clientY: 600 })).toBe(false);
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

  it("treats any page with a video taking a good part of the screen as a watch page, and leaves others alone", () => {
    const watch = new FakeVideo();
    watch.box = { top: 100, left: 0, width: 400, height: 225, bottom: 325, right: 400 };
    const player = load({
      controls: { fullVideos: true },
      feed: false,
      pathname: "/home",
      videos: [watch],
      current: null,
    });
    expect(player.click(200, 200).kept).toBe(true);
    const none = load({
      controls: { fullVideos: true },
      feed: false,
      pathname: "/home",
      videos: [],
      current: null,
    });
    expect(none.click(200, 200).kept).toBe(false);

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
