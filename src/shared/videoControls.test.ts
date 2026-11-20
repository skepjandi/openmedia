import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteVideo, VideoControls } from "./ipc";
import { VIDEO_CONTROLS_DEFAULT } from "./videoControls";

const read = (name: string) =>
  readFileSync(new URL(`../../src-tauri/src/${name}`, import.meta.url), "utf8");
const SOURCE = read("video_controls.js").replace("/*@DETECTORS@*/", () =>
  read("video_detectors.js"),
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
  /** True when the page's script was told the element left the document, as a site's removal does. */
  detached = false;

  get isConnected(): boolean {
    return !this.detached && (this.parentNode?.isConnected ?? true);
  }
  private text = "";
  /** The icon the page last put on this element, as its script records it. */
  __icon?: string;
  /** The seconds a skip button's icon carries. */
  __label?: string;
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
  /** The page's window, for what a site defines on it. */
  window: Record<string, unknown>;
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
  /** Videos that ignore a set volume, as on iOS. */
  volumeLocked?: boolean;
  pathname?: string;
  /** True when the script runs inside a frame of the page, as another site's player does. */
  frame?: boolean;
  /** The frames the page has. */
  frames?: FakeFrame[];
  videos: FakeVideo[];
  current: FakeVideo | null;
  saved?: Record<string, unknown>;
  /** Globals the page has, such as a player library's. */
  win?: Record<string, unknown>;
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
    createElement: (tag?: string) =>
      tag === "video" && options.volumeLocked
        ? Object.defineProperty({}, "volume", { get: () => 1, set: () => {} })
        : new FakeElement(),
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
  Object.defineProperties(win, Object.getOwnPropertyDescriptors(options.win ?? {}));
  const parentPosts: unknown[] = [];
  const parent = { postMessage: (message: unknown) => parentPosts.push(message) };
  win.parent = parent;
  win.screen = { width: 400, height: 800 };
  win.top = options.frame ? parent : win;
  win.__parent = parent;
  const context = vm.createContext(win);
  const config = JSON.stringify({
    ...VIDEO_CONTROLS_DEFAULT,
    panel: true, // the app starts with it off; most of these tests are about the panel
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
    window: win,
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

/** The list a panel button opened: shown, with a row that takes a tap for each choice. */
function openedList(page: Page) {
  return page.body
    .descendants()
    .find(
      (element) =>
        element.style.display === "block" &&
        element.children.length > 0 &&
        element.children.every((row) => row.handlers.has("pointerup")),
    );
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

  it("starts the next video at the speed the reader last chose, across pages only when asked", () => {
    const video = new FakeVideo();
    const page = load({
      controls: { remember: true },
      videos: [video],
      current: video,
      saved: { rate: 1.5 },
    });
    page.fire("loadstart", { target: video });
    expect(video.playbackRate).toBe(1.5);
    expect(video.defaultPlaybackRate).toBe(1.5);

    const fresh = new FakeVideo();
    const forgetful = load({ videos: [fresh], current: fresh, saved: { rate: 1.5 } });
    forgetful.fire("loadstart", { target: fresh });
    expect(fresh.playbackRate).toBe(1);
  });

  it("carries a speed picked in the panel to the next video on the page without saving it", () => {
    const first = new FakeVideo();
    const next = new FakeVideo(800);
    const page = load({ videos: [first, next], current: first });
    openPanel(page);
    page.body
      .descendants()
      .find((element) => element.textContent === "1\u00d7")
      ?.fire("pointerup");
    openedList(page)
      ?.children.find((row) => row.textContent.endsWith("2\u00d7"))
      ?.fire("pointerup");
    expect(first.playbackRate).toBe(2);
    page.setCurrent(next);
    page.fire("loadstart", { target: next });
    expect(next.playbackRate).toBe(2);
    expect(page.storage.has("openmedia.video")).toBe(false);
  });

  it("carries the sound the reader set with the site's own button to the next video", () => {
    const first = new FakeVideo();
    const next = new FakeVideo(800);
    first.muted = true;
    next.muted = true;
    const page = load({ videos: [first, next], current: first });
    first.muted = false;
    page.fire("touchend");
    page.fire("volumechange", { target: first });
    page.setCurrent(next);
    page.fire("loadstart", { target: next });
    expect(next.muted).toBe(false);
  });

  it("puts the sound on a video whose loadstart the page never saw, when it starts", () => {
    const first = new FakeVideo();
    const next = new FakeVideo(800);
    const page = load({ videos: [first, next], current: first });
    openPanel(page);
    buttonWith(page, "sound").fire("pointerup");
    expect(first.muted).toBe(true);
    next.muted = false;
    page.setCurrent(next);
    page.fire("play", { target: next });
    expect(next.muted).toBe(true);
  });

  it("puts the reader's sound back when a site changes it as a video starts, and not later", () => {
    const first = new FakeVideo();
    const next = new FakeVideo(800);
    const page = load({ videos: [first, next], current: first });
    first.muted = false;
    page.fire("touchend");
    page.fire("volumechange", { target: first });
    page.setCurrent(next);
    page.fire("loadstart", { target: next });
    page.fire("playing", { target: next });
    next.muted = true;
    page.fire("volumechange", { target: next });
    expect(next.muted).toBe(false);
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

  it("offers the video's own caption and audio tracks, and nothing when it has none", () => {
    const track = (label: string, mode: string) => ({ kind: "subtitles", label, mode });
    const video = new FakeVideo() as FakeVideo & {
      textTracks?: Array<{ kind: string; label: string; mode: string }>;
      audioTracks?: Array<{ label: string; enabled: boolean }>;
    };
    video.textTracks = [track("English", "disabled"), track("Fran\u00e7ais", "disabled")];
    video.audioTracks = [
      { label: "Original", enabled: true },
      { label: "Dub", enabled: false },
    ];
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const cc = buttonWith(page, "cc");
    expect(cc.style.display).toBe("flex");
    expect(cc.style.opacity).toBe(".45");
    cc.fire("pointerup");
    expect(video.textTracks.map((item) => item.mode)).toEqual(["showing", "disabled"]);
    cc.fire("pointerup");
    expect(video.textTracks.map((item) => item.mode)).toEqual(["disabled", "showing"]);
    cc.fire("pointerup");
    expect(video.textTracks.map((item) => item.mode)).toEqual(["disabled", "disabled"]);
    buttonWith(page, "audio").fire("pointerup");
    expect(video.audioTracks.map((item) => item.enabled)).toEqual([false, true]);

    const bare = new FakeVideo();
    const other = load({ videos: [bare], current: bare });
    openPanel(other);
    expect(buttonWith(other, "cc").style.display).toBe("none");
    expect(buttonWith(other, "audio").style.display).toBe("none");
  });

  it("shows the options a recipe's script offers for its site's player, and runs the one picked", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    const picked: number[] = [];
    let level = 1;
    (page.document as Record<symbol, unknown>)[Symbol.for("openmedia.videoOptions")] = () => [
      {
        kind: "quality",
        label: "Quality",
        items: [
          { label: "Auto", selected: level === 0 },
          { label: "720p", selected: level === 1 },
          { label: "1080p", selected: level === 2 },
        ],
        select: (index: number) => {
          picked.push(index);
          level = index;
        },
      },
      { kind: "quality", items: [], select: () => {} },
      { kind: "other", items: [{ label: "x" }], select: "not a function" },
    ];
    openPanel(page);
    const gear = buttonWith(page, "gear");
    gear.fire("pointerup");
    const menu = openedList(page);
    expect(menu?.children.map((row) => row.textContent)).toEqual([
      "\u2003Auto",
      "\u2713 720p",
      "\u2003" + "1080p",
    ]);
    menu?.children[2]?.fire("pointerup");
    expect(picked).toEqual([2]);
    expect(menu?.style.display).toBe("none");
  });

  it("offers no option buttons when no script provides any, and survives one that throws", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    (page.document as Record<symbol, unknown>)[Symbol.for("openmedia.videoOptions")] = () => {
      throw new Error("the site changed");
    };
    openPanel(page);
    expect(() => buttonWith(page, "gear")).toThrow();
    expect(shown(page)).toBe(true);
  });

  describe("options of a player library", () => {
    const OPTIONS = Symbol.for("openmedia.videoOptions");

    /** Opens the panel and the menu of the gear button; the rows' text, or null when there is no gear. */
    function menuOf(page: Page, icon = "gear") {
      openPanel(page);
      const opener = page.body.descendants().find((element) => element.__icon === icon);
      if (!opener || opener.style.display === "none") return null;
      opener.fire("pointerup");
      const menu = openedList(page);
      return { menu, rows: menu?.children.map((row) => row.textContent) };
    }

    const hlsOf = (video: FakeVideo, extra: Record<string, unknown> = {}) => ({
      levels: [{ height: 360 }, { height: 720 }, { bitrate: 2_500_000 }],
      currentLevel: 1,
      autoLevelEnabled: false,
      attachMedia() {},
      media: video,
      ...extra,
    });

    it("offers hls.js levels found by the video it is attached to, and sets the level picked", () => {
      const video = new FakeVideo();
      const hls = hlsOf(video);
      const page = load({ videos: [video], current: video, win: { player: { inner: 1 }, hls } });
      const opened = menuOf(page);
      expect(opened?.rows).toEqual(["\u2003Auto", "\u2003360p", "\u2713 720p", "\u20032500 kbps"]);
      opened?.menu?.children[3]?.fire("pointerup");
      expect(hls.currentLevel).toBe(2);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2000);
      hls.autoLevelEnabled = true;
      expect(menuOf(page)?.rows?.[0]).toBe("\u2713 Auto");
    });

    it("sets hls.js back to automatic with its first item", () => {
      const video = new FakeVideo();
      const hls = hlsOf(video);
      const page = load({ videos: [video], current: video, win: { hls } });
      menuOf(page)?.menu?.children[0]?.fire("pointerup");
      expect(hls.currentLevel).toBe(-1);
    });

    it("ignores an hls.js attached to another video, and one with a single level", () => {
      const video = new FakeVideo();
      const other = hlsOf(new FakeVideo());
      const single = hlsOf(video, { levels: [{ height: 720 }] });
      const page = load({ videos: [video], current: video, win: { other, single } });
      expect(menuOf(page)).toBeNull();
      expect(shown(page)).toBe(true);
    });

    it("survives a library object that throws on any access, and keeps the others", () => {
      const video = new FakeVideo();
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("no");
          },
          ownKeys() {
            throw new Error("no");
          },
        },
      );
      const hls = hlsOf(video);
      const page = load({
        videos: [video],
        current: video,
        win: {
          hostile,
          videojs: hostile,
          get trap() {
            throw new Error("no");
          },
          hls,
        },
      });
      expect(menuOf(page)?.rows).toHaveLength(4);
      expect(shown(page)).toBe(true);
    });

    it("shows nothing when a library's own reading throws", () => {
      const video = new FakeVideo();
      const hls = hlsOf(video);
      Object.defineProperty(hls, "levels", {
        get() {
          throw new Error("torn down");
        },
      });
      const page = load({ videos: [video], current: video, win: { hls } });
      expect(menuOf(page)).toBeNull();
      expect(shown(page)).toBe(true);
    });

    it("lets a recipe's group of the same kind win over the library's, and adds other kinds", () => {
      const video = new FakeVideo();
      const page = load({ videos: [video], current: video, win: { hls: hlsOf(video) } });
      page.document[OPTIONS] = () => [
        {
          kind: "quality",
          label: "Mine",
          items: [{ label: "Only" }, { label: "Two" }],
          select: () => {},
        },
        { kind: "other", label: "Speed", items: [{ label: "x" }], select: () => {} },
      ];
      const opened = menuOf(page);
      expect(opened?.rows).toEqual(["\u2003Only", "\u2003Two"]);
      const gears = page.body.descendants().filter((element) => element.__icon === "gear");
      expect(gears.filter((element) => element.style.display !== "none")).toHaveLength(2);

      const captions = load({ videos: [video], current: video, win: { hls: hlsOf(video) } });
      captions.document[OPTIONS] = () => [
        { kind: "captions", label: "CC", items: [{ label: "En" }], select: () => {} },
      ];
      openPanel(captions);
      expect(
        captions.body.descendants().filter((element) => element.__icon === "gear"),
      ).toHaveLength(1);
      expect(buttonWith(captions, "cc")).toBeDefined();
    });

    it("looks for the library again only after a few seconds", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const video = new FakeVideo();
      const hls = hlsOf(video);
      const page = load({ videos: [video], current: video, win: { hls } });
      expect(menuOf(page)).not.toBeNull();
      hls.media = new FakeVideo();
      vi.setSystemTime(Date.now() + 1000);
      page.tick();
      expect(menuOf(page)).not.toBeNull();
      vi.setSystemTime(Date.now() + 4000);
      page.tick();
      expect(menuOf(page)).toBeNull();
    });

    it("offers video.js quality levels of the player that holds the video", () => {
      const video = new FakeVideo();
      const levels = Object.assign(
        [
          { height: 360, enabled: true },
          { height: 720, enabled: true },
        ],
        {},
      );
      const player = {
        el: () => ({ contains: (node: unknown) => node === video }),
        qualityLevels: () => levels,
      };
      const stranger = {
        el: () => ({ contains: () => false }),
        tech_: { el: () => null },
        qualityLevels: () => [],
      };
      const videojs = { getAllPlayers: () => [stranger, player] };
      const page = load({ videos: [video], current: video, win: { videojs } });
      const opened = menuOf(page);
      expect(opened?.rows).toEqual(["\u2713 Auto", "\u2003360p", "\u2003720p"]);
      opened?.menu?.children[2]?.fire("pointerup");
      expect(levels.map((level) => level.enabled)).toEqual([false, true]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2000);
      page.tick();
      expect(menuOf(page)?.rows).toEqual(["\u2003Auto", "\u2003360p", "\u2713 720p"]);
      opened?.menu?.children[0]?.fire("pointerup");
      expect(levels.map((level) => level.enabled)).toEqual([true, true]);
    });

    it("finds a video.js player in videojs.players by its tech element", () => {
      const video = new FakeVideo();
      const levels = [
        { height: 480, enabled: true },
        { height: 1080, enabled: true },
      ];
      const videojs = {
        players: {
          a: {
            el: () => ({ contains: () => false }),
            tech: () => ({ el: () => video }),
            qualityLevels: () => levels,
          },
        },
      };
      const page = load({ videos: [video], current: video, win: { videojs } });
      expect(menuOf(page)?.rows).toEqual(["\u2713 Auto", "\u2003480p", "\u20031080p"]);
    });

    it("offers dash.js levels and turns automatic switching off for a fixed one", () => {
      const video = new FakeVideo();
      const calls: unknown[] = [];
      const dash = {
        getVideoElement: () => video,
        getBitrateInfoListFor: () => [{ height: 360 }, { height: 720 }],
        getQualityFor: () => 1,
        getSettings: () => ({ streaming: { abr: { autoSwitchBitrate: { video: false } } } }),
        updateSettings: (settings: unknown) => calls.push(["settings", settings]),
        setQualityFor: (type: string, index: number) => calls.push(["quality", type, index]),
      };
      const page = load({ videos: [video], current: video, win: { dash } });
      const opened = menuOf(page);
      expect(opened?.rows).toEqual(["\u2003Auto", "\u2003360p", "\u2713 720p"]);
      opened?.menu?.children[1]?.fire("pointerup");
      expect(calls).toEqual([
        ["settings", { streaming: { abr: { autoSwitchBitrate: { video: false } } } }],
        ["quality", "video", 0],
      ]);
      calls.length = 0;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2000);
      menuOf(page)?.menu?.children[0]?.fire("pointerup");
      expect(calls).toEqual([
        ["settings", { streaming: { abr: { autoSwitchBitrate: { video: true } } } }],
      ]);
    });

    it("offers Shaka's video heights, one per height, and selects its track with abr off", () => {
      const video = new FakeVideo();
      const calls: unknown[] = [];
      const tracks = [
        { id: 1, height: 360, bandwidth: 500, active: false },
        { id: 2, height: 720, bandwidth: 900, active: true },
        { id: 3, height: 720, bandwidth: 1500, active: false },
        { id: 4, height: null, bandwidth: 100, active: false },
      ];
      const shaka = {
        getMediaElement: () => video,
        getVariantTracks: () => tracks,
        getConfiguration: () => ({ abr: { enabled: false } }),
        configure: (config: unknown) => calls.push(["configure", config]),
        selectVariantTrack: (track: unknown, clear: boolean) =>
          calls.push(["select", track, clear]),
      };
      const page = load({ videos: [video], current: video, win: { shaka } });
      const opened = menuOf(page);
      expect(opened?.rows).toEqual(["\u2003Auto", "\u2713 720p", "\u2003360p"]);
      opened?.menu?.children[1]?.fire("pointerup");
      expect(calls).toEqual([
        ["configure", { abr: { enabled: false } }],
        ["select", tracks[2], true],
      ]);
      calls.length = 0;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2000);
      menuOf(page)?.menu?.children[0]?.fire("pointerup");
      expect(calls).toEqual([["configure", { abr: { enabled: true } }]]);
    });

    it("offers Plyr's qualities from the video's plyr, and nothing for fewer than two", () => {
      const video = new FakeVideo() as FakeVideo & { plyr?: unknown };
      const plyr = { options: { quality: [1080, 720, 360] }, quality: 720 };
      video.plyr = plyr;
      const page = load({ videos: [video], current: video });
      const opened = menuOf(page);
      expect(opened?.rows).toEqual(["\u20031080p", "\u2713 720p", "\u2003360p"]);
      opened?.menu?.children[2]?.fire("pointerup");
      expect(plyr.quality).toBe(360);

      const lone = new FakeVideo() as FakeVideo & { plyr?: unknown };
      lone.plyr = { options: { quality: [720] }, quality: 720 };
      expect(menuOf(load({ videos: [lone], current: lone }))).toBeNull();
    });

    it("offers a player object's quality levels from the element that holds the video", () => {
      const video = new FakeVideo();
      const calls: unknown[] = [];
      const player = {
        contains: (node: unknown) => node === video,
        getAvailableQualityLevels: () => ["hd1080", "hd720", "large", "medium", "tiny"],
        getPlaybackQuality: () => "hd720",
        setPlaybackQualityRange: (low: string, high: string) => calls.push(["range", low, high]),
        setPlaybackQuality: (id: string) => calls.push(["quality", id]),
      };
      const page = load({ videos: [video], current: video });
      page.document.getElementById = (id: string) => (id === "movie_player" ? player : null);
      const opened = menuOf(page);
      expect(opened?.rows).toEqual([
        "\u2003Auto",
        "\u20031080p",
        "\u2713 720p",
        "\u2003480p",
        "\u2003360p",
        "\u2003144p",
      ]);
      opened?.menu?.children[1]?.fire("pointerup");
      expect(calls).toEqual([
        ["range", "hd1080", "hd1080"],
        ["quality", "hd1080"],
      ]);

      const elsewhere = new FakeVideo();
      const other = load({ videos: [elsewhere], current: elsewhere });
      other.document.querySelector = () => player;
      expect(menuOf(other)).toBeNull();
    });
  });

  it("is not moved by presses a script makes, only by the reader's", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    const press = { clientX: 200, clientY: 400, target: PLAIN };
    page.win("click", { ...press, isTrusted: false });
    page.win("pointerdown", { ...press, isTrusted: false });
    page.win("pointerup", { ...press, isTrusted: false });
    page.tick();
    expect(shown(page)).toBe(false);
    openPanel(page);
    expect(shown(page)).toBe(true);
    page.win("click", { ...press, isTrusted: false });
    page.tick();
    expect(shown(page)).toBe(true);
  });

  it("offers JW Player's and Vidstack's quality levels from the video itself", () => {
    const picks: string[] = [];
    const jwVideo = new FakeVideo() as FakeVideo & { closest?: (selector: string) => unknown };
    jwVideo.closest = (selector) => (selector === ".jwplayer" ? { id: "jw6" } : null);
    const jw = {
      getQualityLevels: () => [{ label: "360p" }, { label: "720p" }],
      getCurrentQuality: () => 1,
      setCurrentQuality: (at: number) => picks.push("jw" + at),
    };
    const jwPage = load({
      videos: [jwVideo],
      current: jwVideo,
      win: { jwplayer: (id: string) => (id === "jw6" ? jw : null) },
    });
    openPanel(jwPage);
    buttonWith(jwPage, "gear").fire("pointerup");
    const rows = openedList(jwPage);
    expect(rows?.children.map((row) => row.textContent)).toEqual(["\u2003360p", "\u2713 720p"]);
    rows?.children[0]?.fire("pointerup");
    expect(picks).toEqual(["jw0"]);

    const qualities = Object.assign(
      [
        { id: "a", height: 480, selected: false },
        { id: "b", height: 720, selected: true },
      ],
      { auto: false, autoSelect: () => picks.push("auto") },
    );
    const vsVideo = new FakeVideo() as FakeVideo & { closest?: (selector: string) => unknown };
    vsVideo.closest = (selector) => (selector === "media-player" ? { qualities } : null);
    const vsPage = load({ videos: [vsVideo], current: vsVideo });
    openPanel(vsPage);
    buttonWith(vsPage, "gear").fire("pointerup");
    const vsRows = openedList(vsPage);
    expect(vsRows?.children.map((row) => row.textContent)).toEqual([
      "\u2003Auto",
      "\u2713 720p",
      "\u2003480p",
    ]);
    vsRows?.children[0]?.fire("pointerup");
    expect(picks).toEqual(["jw0", "auto"]);
  });

  it("finds an hls.js player the page keeps in a variable of its own, by remembering the ones it makes", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    class Hls {
      levels = [{ height: 360 }, { height: 720 }];
      currentLevel = -1;
      autoLevelEnabled = true;
      media: unknown = null;
      attachMedia(media: unknown) {
        this.media = media;
      }
    }
    // The page defines its library after the controls started, then makes a player nobody can reach.
    page.window.Hls = Hls;
    const player = new (page.window.Hls as typeof Hls)();
    player.attachMedia(video);
    expect(player).toBeInstanceOf(Hls);
    openPanel(page);
    buttonWith(page, "gear").fire("pointerup");
    const rows = openedList(page);
    expect(rows?.children.map((row) => row.textContent)).toEqual([
      "\u2713 Auto",
      "\u2003360p",
      "\u2003720p",
    ]);
    rows?.children[2]?.fire("pointerup");
    expect(player.currentLevel).toBe(1);
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
    const watch = (
      options: { controls?: Partial<VideoControls>; sites?: Record<string, SiteVideo> } = {},
    ) => {
      const home = new FakeElement();
      const video = new PlacedVideo();
      home.appendChild(video as unknown as FakeElement);
      const page = load({
        ...options,
        videos: [video],
        current: video,
        pathname: "/watch",
        feed: false,
      });
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

    const held = (page: Page) =>
      (page.document as Record<symbol, unknown>)[Symbol.for("openmedia.holdRefresh")];

    it("still lifts the video into the small player when the panel is off", () => {
      const { video, page } = watch({ controls: { panel: false } });
      expect(held(page)).toBe(true);
      page.win("touchstart", touch(100));
      page.win("touchmove", touch(130));
      const box = miniBox(page);
      expect(box).toBeDefined();
      page.win("touchmove", touch(300));
      expect(page.win("touchend", touch(300))).toBe(true);
      page.runTimers();
      expect(page.posts).toContainEqual({ float: true });
      expect(video.parentNode).toBe(box);
    });

    it.each([
      ["app-wide", { controls: { dragToMini: false } }],
      ["for the site", { sites: { "youtube.com": { dragToMini: false } } }],
    ])(
      "leaves the drag to the site and holds no pull to refresh when it is off %s",
      (_, options) => {
        const { page } = watch(options);
        page.tick();
        expect(held(page)).toBeFalsy();
        page.win("touchstart", touch(100));
        expect(page.win("touchmove", touch(130))).toBe(false);
        expect(page.win("touchmove", touch(300))).toBe(false);
        expect(page.win("touchend", touch(300))).toBe(false);
        expect(miniBox(page)).toBeUndefined();
        page.runTimers();
        expect(page.posts).not.toContainEqual({ float: true });
      },
    );

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

    it("in a frame, leaves the player to the site when the page passes on that dragging is off", () => {
      const video = new PlacedVideo();
      const page = load({
        frame: true,
        feed: false,
        videos: [video],
        current: video,
        pathname: "/embed/one",
      });
      const touch = {
        touches: [{ clientX: 200, clientY: 100, screenX: 200, screenY: 100 }],
      };
      page.win("message", {
        source: {},
        data: { om: "config", config: { ...VIDEO_CONTROLS_DEFAULT, dragToMini: false, sites: {} } },
      });
      page.win("touchstart", touch);
      expect(page.parentPosts).toEqual([{ om: "drag-start" }]);
      page.parentPosts.length = 0;
      page.win("message", {
        source: page.parent,
        data: { om: "config", config: { ...VIDEO_CONTROLS_DEFAULT, dragToMini: false, sites: {} } },
      });
      page.win("touchstart", touch);
      expect(page.parentPosts).toEqual([]);
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

  it("does not start a video again on close when the reader paused it in the small player", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    box?.children.find((child) => child.__icon === "pause")?.fire("pointerup");
    expect(video.paused).toBe(true);
    box?.children.find((child) => child.__icon === "close")?.fire("pointerup");
    expect(video.parentNode).toBe(home);
    expect(video.paused).toBe(true);
  });

  it("pauses, not plays on, when the closed small player's place was removed by the site", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    home.detached = true;
    box?.children.find((child) => child.__icon === "close")?.fire("pointerup");
    expect(video.paused).toBe(true);
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

  it("skips by the seconds chosen, for the app or for the site, and stays inside the video", () => {
    const video = new FakeVideo();
    video.currentTime = 3;
    const page = load({ videos: [video], current: video });
    openPanel(page);
    expect(buttonWith(page, "forward").__label).toBe("10");
    buttonWith(page, "back").fire("pointerup");
    expect(video.currentTime).toBe(0);
    buttonWith(page, "forward").fire("pointerup");
    expect(video.currentTime).toBe(10);
    video.currentTime = 18;
    buttonWith(page, "forward").fire("pointerup");
    expect(video.currentTime).toBe(20);

    const short = new FakeVideo();
    const site = load({
      controls: { skip: 30 },
      sites: { "youtube.com": { skip: 5 } },
      videos: [short],
      current: short,
    });
    openPanel(site);
    expect(buttonWith(site, "back").__label).toBe("5");
    buttonWith(site, "forward").fire("pointerup");
    expect(short.currentTime).toBe(5);
  });

  it("skips with a double tap on either side of the video, and adds up the taps that follow", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const video = new FakeVideo();
    video.duration = 100;
    video.currentTime = 50;
    const page = load({ videos: [video], current: video });
    expect(page.click(350, 400).kept).toBe(true);
    page.tick();
    expect(shown(page)).toBe(true);
    expect(page.click(350, 400).kept).toBe(true);
    expect(video.currentTime).toBe(60);
    page.tick();
    expect(shown(page)).toBe(true);
    page.click(350, 400);
    expect(video.currentTime).toBe(70);
    expect(page.body.descendants().some((element) => element.textContent === "+20")).toBe(true);

    // The other side starts again: its first tap puts the panel away, the second skips back.
    page.click(50, 400);
    expect(video.currentTime).toBe(70);
    page.click(50, 400);
    expect(video.currentTime).toBe(60);
    expect(page.body.descendants().some((element) => element.textContent === "\u221210")).toBe(
      true,
    );

    // Taps far apart are each a tap.
    vi.setSystemTime(Date.now() + 1000);
    page.click(50, 400);
    expect(video.currentTime).toBe(60);
  });

  it("works from the keyboard only while the panel is up, and leaves typing alone", () => {
    const video = new FakeVideo();
    video.currentTime = 5;
    const page = load({ videos: [video], current: video });
    const key = (name: string, target: Record<string, unknown> = {}) => {
      let kept = false;
      page.fire("keydown", {
        key: name,
        target,
        cancelable: true,
        preventDefault() {},
        stopImmediatePropagation() {
          kept = true;
        },
      });
      return kept;
    };
    expect(key(" ")).toBe(false);
    expect(video.paused).toBe(false);
    openPanel(page);
    expect(key(" ")).toBe(true);
    expect(video.paused).toBe(true);
    expect(key("ArrowRight")).toBe(true);
    expect(video.currentTime).toBe(15);
    expect(key("m", { tagName: "INPUT" })).toBe(false);
    expect(video.muted).toBe(false);
    expect(key("M")).toBe(true);
    expect(video.muted).toBe(true);
    expect(key("Escape")).toBe(true);
    page.tick();
    expect(shown(page)).toBe(false);
    expect(key("ArrowLeft")).toBe(false);
    expect(video.currentTime).toBe(15);
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

  it("lists the speeds from the speed button, ticks the one playing, and saves a pick when asked", () => {
    const video = new FakeVideo();
    video.playbackRate = 1.5;
    const page = load({ controls: { remember: true }, videos: [video], current: video });
    openPanel(page);
    page.body
      .descendants()
      .find((element) => element.textContent === "1.5\u00d7")
      ?.fire("pointerup");
    const list = openedList(page);
    expect(list?.children.map((row) => row.textContent)).toEqual([
      "\u20030.5\u00d7",
      "\u20030.75\u00d7",
      "\u20031\u00d7",
      "\u20031.25\u00d7",
      "\u2713 1.5\u00d7",
      "\u20031.75\u00d7",
      "\u20032\u00d7",
      "\u20033\u00d7",
    ]);
    list?.children[3]?.fire("pointerup");
    expect(video.playbackRate).toBe(1.25);
    expect(JSON.parse(page.storage.get("openmedia.video") ?? "{}").rate).toBe(1.25);
    expect(list?.style.display).toBe("none");
  });

  it("seeks where the bar is touched, a few times a second while dragged, exactly on release", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const video = new FakeVideo() as FakeVideo & { fastSeek?: (time: number) => void };
    const quick: number[] = [];
    video.fastSeek = (time) => quick.push(time);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const track = sliders(page).at(-1);
    track?.fire("pointerdown", { clientX: 100 });
    expect(video.currentTime).toBe(5);
    track?.fire("pointermove", { clientX: 300 });
    expect(quick).toEqual([]);
    vi.setSystemTime(Date.now() + 200);
    track?.fire("pointermove", { clientX: 200 });
    expect(quick).toEqual([10]);
    page.fire("click");
    track?.fire("pointerup");
    expect(video.currentTime).toBe(10);
    page.tick();
    const visible = (text: string) =>
      page.body
        .descendants()
        .filter((element) => element.textContent === text && element.style.display !== "none");
    expect(visible("0:10")).toHaveLength(1);
    expect(visible("-0:10")).toHaveLength(1);
  });

  it("seeks inside a live stream's window, says how far behind live it is, and goes back to live", () => {
    const video = new FakeVideo() as FakeVideo & {
      seekable?: { length: number; start: () => number; end: () => number };
    };
    video.duration = Infinity;
    video.currentTime = 130;
    video.seekable = { length: 1, start: () => 100, end: () => 160 };
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const behind = page.body
      .descendants()
      .find((element) => element.textContent === "\u25cf -0:30");
    expect(behind).toBeDefined();
    const track = sliders(page).at(-1);
    track?.fire("pointerdown", { clientX: 100 });
    track?.fire("pointerup");
    expect(video.currentTime).toBe(115);
    behind?.fire("pointerup");
    expect(video.currentTime).toBe(159);
    page.tick();
    expect(behind?.textContent).toBe("\u25cf");
    buttonWith(page, "forward").fire("pointerup");
    expect(video.currentTime).toBe(160);
  });

  it("moves the knob with the finger while the bar is dragged", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const track = sliders(page).at(-1);
    const knob = track?.children[0]?.children[1];
    track?.fire("pointerdown", { clientX: 100 });
    expect(knob?.style.left).toBe("25%");
    track?.fire("pointermove", { clientX: 300 });
    expect(knob?.style.left).toBe("75%");
    track?.fire("pointerup");
  });

  it("stops just short of the end, which would count as the video ending", () => {
    const video = new FakeVideo();
    const page = load({ videos: [video], current: video });
    openPanel(page);
    sliders(page).at(-1)?.fire("pointerdown", { clientX: 400 });
    expect(video.currentTime).toBe(19.75);
  });

  it("sets the video's own volume from the volume bar where the page can, and mutes at the bottom", () => {
    const video = new FakeVideo();
    video.muted = true;
    video.volume = 1;
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const bar = sliders(page)[0];
    bar?.fire("pointerdown", { clientX: 100 });
    expect(video.volume).toBe(0.25);
    expect(video.muted).toBe(false);
    bar?.fire("pointermove", { clientX: 0 });
    expect(video.muted).toBe(true);
    bar?.fire("pointerup");
  });

  it("shows no volume bar, only the mute button, where a video's volume cannot be set", () => {
    const video = new FakeVideo();
    const locked = load({ videos: [video], current: video, volumeLocked: true });
    openPanel(locked);
    expect(sliders(locked)[0]?.style.display).toBe("none");

    const free = load({ videos: [video], current: video });
    openPanel(free);
    expect(sliders(free)[0]?.style.display).toBe("flex");
  });

  it("shows no volume bar on iOS, where the page cannot set the volume", () => {
    const video = new FakeVideo();
    const iphone = load({
      videos: [video],
      current: video,
      win: { navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" } },
    });
    openPanel(iphone);
    expect(sliders(iphone)[0]?.style.display).toBe("none");
  });

  it("takes the volume bar away on a page that puts a middle volume back", () => {
    const video = new FakeVideo();
    Object.defineProperty(video, "volume", { get: () => 1, set: () => {} });
    const page = load({ videos: [video], current: video });
    openPanel(page);
    const bar = sliders(page)[0];
    expect(bar?.style.display).toBe("flex");
    bar?.fire("pointerdown", { clientX: 100 });
    bar?.fire("pointerup");
    page.runTimers();
    page.tick();
    expect(bar?.style.display).toBe("none");
  });

  it("fits the small player to a turned or resized screen, inside it", () => {
    const home = new FakeElement();
    const video = new PlacedVideo();
    home.appendChild(video as unknown as FakeElement);
    const page = load({ videos: [video], current: video });
    openPanel(page);
    buttonWith(page, "pip").fire("pointerup");
    const box = page.body.children.find((child) => "data-openmedia-mini" in child.attributes);
    box?.fire("pointerdown", { clientX: 300, clientY: 600 });
    box?.fire("pointermove", { clientX: 100, clientY: 100 });
    box?.fire("pointerup");
    page.window.innerWidth = 800;
    page.window.innerHeight = 400;
    page.win("resize");
    expect(box?.style.width).toBe("240px");
    expect(box?.style.height).toBe("128px");
    expect(box?.style.right).toBe("208px");
    expect(box?.style.bottom).toBe("272px");
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

  it("lets a site's own remember, loop-off and auto-advance beat the shared ones", () => {
    const video = new FakeVideo();
    const loopOff = load({
      videos: [video],
      current: video,
      sites: { "youtube.com": { loopOff: true } },
    });
    video.loop = true;
    loopOff.fire("loadstart", { target: video });
    expect(video.loop).toBe(false);

    const loopKept = load({
      controls: { loopOff: true },
      videos: [video],
      current: video,
      sites: { "youtube.com": { loopOff: false } },
    });
    video.loop = true;
    loopKept.fire("loadstart", { target: video });
    expect(video.loop).toBe(true);

    const other = load({
      videos: [video],
      current: video,
      hostname: "www.notyoutube.com",
      sites: { "youtube.com": { loopOff: true } },
    });
    video.loop = true;
    other.fire("loadstart", { target: video });
    expect(video.loop).toBe(true);

    const sound = load({
      videos: [video],
      current: video,
      sites: { "youtube.com": { remember: true } },
    });
    video.muted = true;
    sound.fire("touchend");
    sound.fire("volumechange", { target: video });
    expect(JSON.parse(sound.storage.get("openmedia.video") ?? "{}").muted).toBe(true);

    const forgotten = load({
      controls: { remember: true },
      videos: [video],
      current: video,
      sites: { "youtube.com": { remember: false } },
    });
    video.muted = true;
    forgotten.fire("touchend");
    forgotten.fire("volumechange", { target: video });
    expect(forgotten.storage.get("openmedia.video")).toBeUndefined();
  });

  it("moves on when the site asks for it, and not when it turns it off, with loop off implied", () => {
    const first = new FakeVideo(0);
    const next = new FakeVideo(800);
    const own = load({
      videos: [first, next],
      current: first,
      sites: { "youtube.com": { autoAdvance: true } },
    });
    first.loop = true;
    own.fire("loadstart", { target: first });
    expect(first.loop).toBe(false);
    own.fire("ended", { target: first });
    expect(next.scrolledIntoView).toBe(1);

    const quiet = new FakeVideo(0);
    const after = new FakeVideo(800);
    const off = load({
      controls: wideOpen(),
      videos: [quiet, after],
      current: quiet,
      sites: { "youtube.com": { autoAdvance: false, loopOff: false } },
    });
    quiet.loop = true;
    off.fire("loadstart", { target: quiet });
    expect(quiet.loop).toBe(true);
    off.fire("ended", { target: quiet });
    expect(after.scrolledIntoView).toBe(0);
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
