import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("../../src-tauri/src/feed_player.js", import.meta.url), "utf8");

type Listener = (event: Record<string, unknown>) => void;

class FakeVideo {
  localName = "video";
  nodeType = 1;
  isConnected = true;
  paused = true;
  ended = false;
  muted = false;
  seeking = false;
  currentTime = 0;
  playCalls = 0;
  playError: string | null = null;
  box = { top: 0, left: 0, width: 400, height: 800, bottom: 800, right: 400 };
  parentElement: { getBoundingClientRect: () => FakeVideo["box"] } | null = null;

  getBoundingClientRect() {
    return this.box;
  }

  play() {
    this.playCalls += 1;
    if (this.playError) {
      const error = Object.assign(new Error(this.playError), { name: this.playError });
      return Promise.reject(error);
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

function listeners() {
  const byType = new Map<string, Listener[]>();
  return {
    addEventListener: (type: string, handler: Listener) => {
      byType.set(type, [...(byType.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: Listener) => {
      byType.set(
        type,
        (byType.get(type) ?? []).filter((candidate) => candidate !== handler),
      );
    },
    fire: (type: string, event: Record<string, unknown> = {}) => {
      for (const handler of byType.get(type) ?? []) handler({ type, ...event });
    },
  };
}

interface Page {
  /** Puts the small player up or takes it down. */
  setMini: (up: boolean) => void;
  clock: { now: number };
  nativeAsks: number[];
  fire: (type: string, event?: Record<string, unknown>) => void;
  /** Lets the debounced settle run, as it does once scrolling stops. */
  settle: (advanceMs?: number) => Promise<void>;
  /** The 1.2 s safety tick. */
  tick: () => Promise<void>;
  /** What the video controls call when the reader pauses or plays with their own buttons. */
  userPause: (video: FakeVideo, paused: boolean) => void;
  /** Reports one added element to the page's mutation observer; returns how often it was searched. */
  addNode: () => number;
  /** Epilepsy protection: the page script that stops autoplay sets this flag. */
  setCalm: () => void;
  /** The video the controls read as the one in view. */
  currentVideo: () => FakeVideo | null;
}

function load(options: {
  videos: FakeVideo[];
  pathname?: string;
  hostname?: string;
  native?: boolean;
}): Page {
  const clock = { now: 1_000_000 };
  let mutate: (records: unknown[]) => void = () => {};
  const timeouts: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  const nativeAsks: number[] = [];
  const documentEvents = listeners();
  const windowEvents = listeners();
  const document = {
    hidden: false,
    /** True while the page has its small player up. */
    miniUp: false,
    querySelector(selector: string) {
      return selector.includes("data-openmedia-mini") && this.miniUp ? {} : null;
    },
    documentElement: {
      nodeType: 1,
      localName: "html",
      querySelectorAll: () => options.videos,
    },
    addEventListener: documentEvents.addEventListener,
    removeEventListener: documentEvents.removeEventListener,
    dispatchEvent: () => true,
  };
  const win: Record<string, unknown> = {
    innerHeight: 800,
    innerWidth: 400,
    location: {
      pathname: options.pathname ?? "/shorts/abc",
      hostname: options.hostname ?? "m.youtube.com",
    },
    document,
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    HTMLVideoElement: FakeVideo,
    MutationObserver: class {
      constructor(callback: (records: unknown[]) => void) {
        mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
    Date: { now: () => clock.now },
    setTimeout: (fn: () => void) => timeouts.push(fn),
    clearTimeout: () => {
      timeouts.length = 0;
    },
    setInterval: (fn: () => void) => intervals.push(fn),
    clearInterval: () => {},
  };
  if (options.native) {
    win.webkit = { messageHandlers: { openmediaPlay: { postMessage: () => nativeAsks.push(1) } } };
  }
  win.window = win;
  win.top = win;
  vm.runInContext(SOURCE, vm.createContext(win));

  return {
    clock,
    nativeAsks,
    fire: documentEvents.fire,
    async settle(advanceMs = 400) {
      clock.now += advanceMs;
      const due = timeouts.splice(0);
      due.forEach((run) => run());
      await Promise.resolve();
      await Promise.resolve();
    },
    async tick() {
      clock.now += 1200;
      intervals.forEach((run) => run());
      await Promise.resolve();
      await Promise.resolve();
    },
    setMini(up) {
      document.miniUp = up;
    },
    setCalm() {
      (document as Record<symbol, unknown>)[Symbol.for("openmedia.noAutoplay")] = true;
    },
    currentVideo() {
      return (document as Record<symbol, FakeVideo | null>)[Symbol.for("openmedia.currentVideo")];
    },
    userPause(video, paused) {
      (document as Record<symbol, (video: FakeVideo, paused: boolean) => void>)[
        Symbol.for("openmedia.userPause")
      ](video, paused);
    },
    addNode() {
      let searches = 0;
      const node = {
        nodeType: 1,
        localName: "div",
        querySelectorAll: () => {
          searches += 1;
          return [];
        },
      };
      mutate([{ addedNodes: [node] }]);
      return searches;
    },
  };
}

function swipe(page: Page) {
  page.fire("touchstart", { touches: [{ clientX: 200, clientY: 600 }] });
  page.fire("touchend", { changedTouches: [{ clientX: 200, clientY: 150 }] });
}

function tap(page: Page) {
  page.fire("touchstart", { touches: [{ clientX: 200, clientY: 400 }] });
  page.fire("touchend", { changedTouches: [{ clientX: 202, clientY: 401 }] });
}

describe("feed player", () => {
  it("plays the video that fills the screen", async () => {
    const video = new FakeVideo();
    const page = load({ videos: [video] });
    await page.settle();
    expect(video.paused).toBe(false);
  });

  it("does not take the pause a site makes during a swipe for the reader's", async () => {
    const video = new FakeVideo();
    const page = load({ videos: [video] });
    await page.settle();
    swipe(page);
    video.pause();
    page.fire("pause", { target: video });
    await page.settle();
    expect(video.paused).toBe(false);
  });

  it("leaves a video the reader paused with a tap alone", async () => {
    const video = new FakeVideo();
    const page = load({ videos: [video] });
    await page.settle();
    page.fire("playing", { target: video });
    await page.settle(700);
    tap(page);
    video.pause();
    page.fire("pause", { target: video });
    await page.settle(100);
    await page.tick();
    expect(video.paused).toBe(true);
  });

  it("keeps playing a video the site paused moments after it started, as when a tab was tapped", async () => {
    const video = new FakeVideo();
    const page = load({ videos: [video] });
    await page.settle();
    tap(page);
    page.fire("playing", { target: video });
    await page.settle(100);
    video.pause();
    page.fire("pause", { target: video });
    await page.settle(400);
    expect(video.paused).toBe(false);
  });

  it("keeps a video paused that the video controls paused, until they play it again", async () => {
    const video = new FakeVideo();
    const page = load({ videos: [video] });
    await page.settle();
    page.userPause(video, true);
    video.pause();
    page.fire("pause", { target: video });
    await page.settle(400);
    await page.tick();
    expect(video.paused).toBe(true);

    page.userPause(video, false);
    page.fire("scroll");
    await page.settle(400);
    expect(video.paused).toBe(false);
  });

  it("gives a reused element a fresh budget of attempts when its source changes", async () => {
    const video = new FakeVideo();
    video.play = function play() {
      this.playCalls += 1;
      return Promise.resolve();
    };
    const page = load({ videos: [video] });
    await page.settle();
    for (let round = 0; round < 9; round += 1) await page.tick();
    const spent = video.playCalls;
    expect(spent).toBe(8);

    page.fire("loadstart", { target: video });
    await page.settle();
    expect(video.playCalls).toBe(spent + 1);
  });

  it("asks native code to play when the engine refuses, and mutes when there is none", async () => {
    const refused = new FakeVideo();
    refused.playError = "NotAllowedError";
    const withNative = load({ videos: [refused], native: true });
    await withNative.settle();
    expect(withNative.nativeAsks).toHaveLength(1);
    expect(refused.muted).toBe(false);

    const alone = new FakeVideo();
    alone.playError = "NotAllowedError";
    const withoutNative = load({ videos: [alone] });
    await withoutNative.settle();
    expect(alone.muted).toBe(true);
  });

  it("asks native code to play a muted video the engine refuses too", async () => {
    const muted = new FakeVideo();
    muted.muted = true;
    muted.playError = "NotAllowedError";
    const page = load({ videos: [muted], native: true });
    await page.settle();
    expect(page.nativeAsks).toHaveLength(1);
  });

  it("treats a wide clip that sits on screen as the video in view", async () => {
    const wide = new FakeVideo();
    wide.box = { top: 290, left: 0, width: 400, height: 225, bottom: 515, right: 400 };
    const page = load({ videos: [wide] });
    await page.settle();
    expect(wide.paused).toBe(false);
  });

  it("stops a video that scrolled out of view", async () => {
    const outgoing = new FakeVideo();
    const incoming = new FakeVideo();
    const page = load({ videos: [outgoing, incoming] });
    outgoing.box = { top: -800, left: 0, width: 400, height: 800, bottom: 0, right: 400 };
    outgoing.paused = false;
    await page.settle();
    expect(outgoing.paused).toBe(true);
    expect(incoming.paused).toBe(false);
  });

  it("leaves the videos alone while the small player is up", async () => {
    const outgoing = new FakeVideo();
    const incoming = new FakeVideo();
    const page = load({ videos: [outgoing, incoming] });
    page.setMini(true);
    outgoing.box = { top: -800, left: 0, width: 400, height: 800, bottom: 0, right: 400 };
    outgoing.paused = false;
    incoming.paused = true;
    await page.settle();
    expect(outgoing.paused).toBe(false);
    expect(incoming.playCalls).toBe(0);
  });

  it("still reports the video in view in calm mode, and starts none", async () => {
    const video = new FakeVideo();
    const page = load({ videos: [video] });
    page.setCalm();
    await page.settle();
    expect(page.currentVideo()).toBe(video);
    expect(video.playCalls).toBe(0);
    await page.tick();
    expect(video.playCalls).toBe(0);
  });

  it("runs on Instagram reels opened from a profile but not on its home feed", async () => {
    const reel = new FakeVideo();
    const profile = load({
      videos: [reel],
      hostname: "www.instagram.com",
      pathname: "/someone/reel/CODE/",
    });
    await profile.settle();
    expect(reel.paused).toBe(false);

    const idle = new FakeVideo();
    const home = load({ videos: [idle], hostname: "www.instagram.com", pathname: "/" });
    await home.settle();
    expect(idle.playCalls).toBe(0);
  });

  it("does not search the page for videos on mutations outside a feed", () => {
    const home = load({ videos: [], hostname: "www.instagram.com", pathname: "/" });
    expect(home.addNode()).toBe(0);
    const reels = load({ videos: [], hostname: "www.instagram.com", pathname: "/reels/" });
    expect(reels.addNode()).toBe(1);
  });

  it("kicks a video that says it plays but never moves", async () => {
    const stuck = new FakeVideo();
    stuck.paused = false;
    const page = load({ videos: [stuck] });
    await page.settle();
    for (let round = 0; round < 5; round += 1) await page.tick();
    expect(stuck.playCalls).toBeGreaterThan(0);
  });

  it("plays a video the site parks far off screen when its wrapper is on screen", async () => {
    const parked = new FakeVideo();
    parked.box = { top: -2682, left: 0, width: 400, height: 800, bottom: -1882, right: 400 };
    parked.parentElement = {
      getBoundingClientRect: () => ({
        top: 0,
        left: 0,
        width: 400,
        height: 800,
        bottom: 800,
        right: 400,
      }),
    };
    const page = load({ videos: [parked] });
    await page.settle();
    expect(parked.paused).toBe(false);
  });

  it("plays a video the site parks 9999 px to the left when its wrapper is on screen height", async () => {
    const parked = new FakeVideo();
    parked.box = { top: -2682, left: -9999, width: 400, height: 800, bottom: -1882, right: -9599 };
    parked.parentElement = {
      getBoundingClientRect: () => ({
        top: 0,
        left: -9999,
        width: 400,
        height: 800,
        bottom: 800,
        right: -9599,
      }),
    };
    const page = load({ videos: [parked] });
    await page.settle();
    expect(parked.paused).toBe(false);
  });

  it("leaves an off-screen video alone when its wrapper is a list taller than the screen", async () => {
    const hidden = new FakeVideo();
    hidden.box = { top: -2682, left: 0, width: 400, height: 800, bottom: -1882, right: 400 };
    hidden.parentElement = {
      getBoundingClientRect: () => ({
        top: -3000,
        left: 0,
        width: 400,
        height: 6000,
        bottom: 3000,
        right: 400,
      }),
    };
    const page = load({ videos: [hidden] });
    await page.settle();
    expect(hidden.playCalls).toBe(0);
  });
});
