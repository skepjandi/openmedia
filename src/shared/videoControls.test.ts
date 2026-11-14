import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { VideoControls } from "./ipc";
import { VIDEO_CONTROLS_OFF } from "./videoControls";

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
}

class FakeElement {
  style = { cssText: "" } as Record<string, string>;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  textContent = "";
  attributes: Record<string, string> = {};
  handlers = new Map<string, Listener[]>();

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

interface Page {
  body: FakeElement;
  storage: Map<string, string>;
  fire: (type: string, event?: Record<string, unknown>) => void;
  /** One 100 ms tick of the controls. */
  tick: () => void;
  scrolls: Array<Record<string, unknown>>;
  setCalm: () => void;
  teardown: () => void;
}

function load(options: {
  controls: Partial<VideoControls>;
  videos: FakeVideo[];
  current: FakeVideo | null;
  saved?: Record<string, unknown>;
}): Page {
  const intervals: Array<() => void> = [];
  const documentListeners = new Map<string, Listener[]>();
  const storage = new Map<string, string>();
  if (options.saved) storage.set("openmedia.video", JSON.stringify(options.saved));
  const body = new FakeElement();
  const scrolls: Array<Record<string, unknown>> = [];
  const document: Record<string | symbol, unknown> = {
    hidden: false,
    body,
    documentElement: body,
    createElement: () => new FakeElement(),
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
  document[Symbol.for("openmedia.isFeed")] = () => true;
  Object.defineProperty(document, Symbol.for("openmedia.currentVideo"), {
    get: () => options.current,
  });
  const win: Record<string, unknown> = {
    innerHeight: 800,
    innerWidth: 400,
    document,
    HTMLVideoElement: FakeVideo,
    MutationObserver: class {
      observe() {}
      disconnect() {}
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
    scrollBy: (by: Record<string, unknown>) => scrolls.push(by),
  };
  win.window = win;
  win.top = win;
  const context = vm.createContext(win);
  const config = JSON.stringify({ ...VIDEO_CONTROLS_OFF, ...options.controls });
  vm.runInContext(`(${SOURCE.trim().replace(/;$/, "")})(${config});`, context);

  return {
    body,
    storage,
    scrolls,
    fire: (type, event = {}) => {
      for (const handler of documentListeners.get(type) ?? []) handler({ type, ...event });
    },
    tick: () => intervals.forEach((run) => run()),
    setCalm: () => {
      document[Symbol.for("openmedia.noAutoplay")] = true;
    },
    teardown: () => (document[Symbol.for("openmedia.videoControls")] as () => void)(),
  };
}

function wideOpen(): Partial<VideoControls> {
  return { seekBar: true, speed: true, remember: true, loopOff: true, autoAdvance: true };
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
    const page = load({ controls: { speed: true }, videos: [video], current: video });
    page.tick();
    expect(video.loop).toBe(true);
  });

  it("starts the next video at the speed the reader last chose", () => {
    const video = new FakeVideo();
    const page = load({
      controls: { remember: true, speed: true },
      videos: [video],
      current: video,
      saved: { rate: 1.5 },
    });
    page.fire("loadstart", { target: video });
    expect(video.playbackRate).toBe(1.5);
    expect(video.defaultPlaybackRate).toBe(1.5);
  });

  it("steps through the speeds when the button is tapped and remembers the choice", () => {
    const video = new FakeVideo();
    const page = load({ controls: { speed: true }, videos: [video], current: video });
    page.tick();
    const [pill] = page.body.descendants().filter((element) => element.textContent.endsWith("×"));
    pill.fire("pointerup");
    expect(video.playbackRate).toBe(1.25);
    pill.fire("pointerup");
    expect(video.playbackRate).toBe(1.5);
    expect(JSON.parse(page.storage.get("openmedia.video") ?? "{}").rate).toBe(1.5);
  });

  it("seeks to where the bar is touched", () => {
    const video = new FakeVideo();
    const page = load({ controls: { seekBar: true }, videos: [video], current: video });
    page.tick();
    const track = page.body.descendants().find((element) => element.handlers.has("pointerdown"));
    track?.fire("pointerdown", { clientX: 100 });
    expect(video.currentTime).toBe(5);
    track?.fire("pointermove", { clientX: 300 });
    expect(video.currentTime).toBe(15);
  });

  it("shows nothing when the page is not a feed or the video is not in view", () => {
    const video = new FakeVideo();
    const page = load({ controls: { seekBar: true }, videos: [video], current: null });
    page.tick();
    const root = page.body.children[0];
    expect(root === undefined || root.style.display === "none").toBe(true);
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
    const off = load({ controls: { seekBar: true }, videos: [first, next], current: first });
    off.fire("ended", { target: first });
    expect(next.scrolledIntoView).toBe(0);

    const calm = load({ controls: wideOpen(), videos: [first, next], current: first });
    calm.setCalm();
    calm.fire("ended", { target: first });
    expect(next.scrolledIntoView).toBe(0);
  });

  it("removes its controls when it is replaced", () => {
    const video = new FakeVideo();
    const page = load({ controls: { seekBar: true }, videos: [video], current: video });
    page.tick();
    expect(page.body.children).toHaveLength(1);
    page.teardown();
    expect(page.body.children).toHaveLength(0);
  });
});
