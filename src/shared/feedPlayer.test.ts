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
  clock: { now: number };
  nativeAsks: number[];
  fire: (type: string, event?: Record<string, unknown>) => void;
  /** Lets the debounced settle run, as it does once scrolling stops. */
  settle: (advanceMs?: number) => Promise<void>;
  /** The 1.2 s safety tick. */
  tick: () => Promise<void>;
}

function load(options: {
  videos: FakeVideo[];
  pathname?: string;
  hostname?: string;
  native?: boolean;
}): Page {
  const clock = { now: 1_000_000 };
  const timeouts: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  const nativeAsks: number[] = [];
  const documentEvents = listeners();
  const windowEvents = listeners();
  const document = {
    hidden: false,
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
    tap(page);
    video.pause();
    page.fire("pause", { target: video });
    await page.settle(100);
    await page.tick();
    expect(video.paused).toBe(true);
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

  it("kicks a video that says it plays but never moves", async () => {
    const stuck = new FakeVideo();
    stuck.paused = false;
    const page = load({ videos: [stuck] });
    await page.settle();
    for (let round = 0; round < 5; round += 1) await page.tick();
    expect(stuck.playCalls).toBeGreaterThan(0);
  });
});
