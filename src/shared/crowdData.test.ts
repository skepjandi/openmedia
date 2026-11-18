import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("../../src-tauri/src/crowd_data.js", import.meta.url), "utf8");

const VIDEO = "dQw4w9WgXcQ";

interface Rule {
  id: string;
  kind: "sponsorBlock" | "dislikeCount";
  videoId: { query?: string; afterSegment?: string };
  categories?: string[];
  target?: string;
}

const SPONSOR: Rule = {
  id: "skip",
  kind: "sponsorBlock",
  videoId: { query: "v" },
  categories: ["sponsor", "intro"],
};
const DISLIKES: Rule = {
  id: "dislikes",
  kind: "dislikeCount",
  videoId: { query: "v" },
  target: "dislike-button-view-model",
};

class FakeVideo {
  currentTime = 0;
  duration = 600;
}

class FakeNode {
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  style = { cssText: "" };
  textContent = "";
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  parent: FakeNode | null = null;
  appendChild(child: FakeNode) {
    child.parent = this;
    this.children.push(child);
  }
  querySelector() {
    return this.children[0] ?? null;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
}

interface Call {
  url: string;
  init: Record<string, unknown>;
}

async function flush() {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

/** `crypto.subtle.digest` answering from already-settled promises, so a test can drain them. */
const crypto = {
  subtle: {
    digest: (_algorithm: string, data: Uint8Array) =>
      Promise.resolve(createHash("sha256").update(data).digest().buffer),
  },
};

function open(
  href: string,
  respond: (url: string) => { ok: boolean; body: unknown },
  options: { top?: boolean } = {},
) {
  const calls: Call[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  let tick: () => void = () => {};
  let intervals = 0;
  const host = new FakeNode();
  const marks: FakeNode[] = [];
  const url = new URL(href);
  const window: Record<string, unknown> = {
    location: { search: url.search, pathname: url.pathname },
    fetch: (target: string, init: Record<string, unknown>) => {
      calls.push({ url: target, init });
      const answer = respond(target);
      return Promise.resolve({ ok: answer.ok, json: () => Promise.resolve(answer.body) });
    },
    crypto,
    setInterval: (callback: () => void) => {
      tick = callback;
      intervals += 1;
      return intervals;
    },
    clearInterval: () => {},
  };
  window.top = options.top === false ? {} : window;
  const document = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener: () => {},
    querySelector: () => host,
    querySelectorAll: () => ({ forEach: (fn: (node: FakeNode) => void) => marks.forEach(fn) }),
    createElement: () => {
      const node = new FakeNode();
      marks.push(node);
      return node;
    },
  };
  const context = vm.createContext({
    window,
    document,
    HTMLVideoElement: FakeVideo,
    TextEncoder,
    URLSearchParams,
    Uint8Array,
    Intl,
    JSON,
    isFinite,
    String,
    Symbol,
    Object,
    Array,
    Math,
  });
  const run = (rules: Rule[]) => vm.runInContext(`(${SOURCE})`, context)(rules);
  const navigate = (next: string) => {
    const target = new URL(next);
    window.location = { search: target.search, pathname: target.pathname };
    tick();
  };
  const play = (video: FakeVideo, time: number) => {
    video.currentTime = time;
    (listeners.timeupdate ?? []).forEach((listener) => listener({ target: video }));
  };
  return { run, calls, navigate, play, host, tick: () => tick(), marks, window };
}

const prefix = createHash("sha256").update(VIDEO).digest("hex").slice(0, 4);

function segments(extra: object[] = []) {
  return {
    ok: true,
    body: [
      {
        videoID: VIDEO,
        segments: [
          { segment: [10, 20], category: "sponsor", actionType: "skip", videoDuration: 600 },
          { segment: [0, 5], category: "intro", actionType: "skip", videoDuration: 0 },
          { segment: [100, 110], category: "outro", actionType: "skip", videoDuration: 600 },
          { segment: [200, 210], category: "sponsor", actionType: "mute", videoDuration: 600 },
          ...extra,
        ],
      },
      {
        videoID: "someoneElse1",
        segments: [{ segment: [1, 2], category: "sponsor", actionType: "skip" }],
      },
    ],
  };
}

describe("sponsorBlock", () => {
  it("asks only for the hash prefix, without cookies or referrer", async () => {
    const page = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => segments());
    page.run([SPONSOR]);
    await flush();
    expect(page.calls).toHaveLength(1);
    const [call] = page.calls;
    expect(call?.url.startsWith(`https://sponsor.ajay.app/api/skipSegments/${prefix}?`)).toBe(true);
    expect(call?.url).not.toContain(VIDEO);
    expect(call?.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(decodeURIComponent(call?.url ?? "")).toContain('categories=["sponsor","intro"]');
  });

  it("skips each wanted segment of this video once and leaves other categories and actions", async () => {
    const page = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => segments());
    page.run([SPONSOR]);
    await flush();
    const video = new FakeVideo();
    page.play(video, 12);
    expect(video.currentTime).toBe(20);
    page.play(video, 15);
    expect(video.currentTime).toBe(15);
    page.play(video, 2);
    expect(video.currentTime).toBe(5);
    page.play(video, 105);
    expect(video.currentTime).toBe(105);
    page.play(video, 205);
    expect(video.currentTime).toBe(205);
    page.play(video, 1.5);
    expect(video.currentTime).toBe(1.5);
  });

  it("leaves a video whose length does not fit the segment, such as an ad in the same player", async () => {
    const page = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => segments());
    page.run([SPONSOR]);
    await flush();
    const ad = new FakeVideo();
    ad.duration = 30;
    page.play(ad, 12);
    expect(ad.currentTime).toBe(12);
    const unrelated = new FakeVideo();
    unrelated.duration = 900;
    page.play(unrelated, 12);
    expect(unrelated.currentTime).toBe(12);
  });

  it("loads the segments of the next video after a navigation and drops the old ones", async () => {
    const page = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => segments());
    page.run([SPONSOR]);
    await flush();
    page.navigate("https://www.youtube.com/feed/subscriptions");
    const video = new FakeVideo();
    page.play(video, 12);
    expect(video.currentTime).toBe(12);
    page.navigate("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await flush();
    expect(page.calls).toHaveLength(2);
    expect(page.calls[1]?.url).not.toContain(prefix);
  });

  it("sends nothing on a page with no valid video id and in a frame", () => {
    const home = open("https://www.youtube.com/", () => segments());
    home.run([SPONSOR, DISLIKES]);
    const bad = open("https://www.youtube.com/watch?v=../../etc", () => segments());
    bad.run([SPONSOR, DISLIKES]);
    const frame = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => segments(), {
      top: false,
    });
    frame.run([SPONSOR, DISLIKES]);
    expect(home.calls.length + bad.calls.length + frame.calls.length).toBe(0);
  });

  it("reads the id from the path segment after a name", async () => {
    const page = open(`https://www.youtube.com/shorts/${VIDEO}`, () => segments());
    page.run([{ ...SPONSOR, videoId: { afterSegment: "shorts" } }]);
    await flush();
    expect(page.calls).toHaveLength(1);
  });

  it("does nothing when the service has no answer", async () => {
    const page = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => ({ ok: false, body: [] }));
    page.run([SPONSOR]);
    await flush();
    const video = new FakeVideo();
    page.play(video, 12);
    expect(video.currentTime).toBe(12);
  });
});

describe("dislikeCount", () => {
  it("sends the id to the dislike service and shows a compact count in the target", async () => {
    const page = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => ({
      ok: true,
      body: { dislikes: 12_345 },
    }));
    page.run([DISLIKES]);
    await flush();
    expect(page.calls[0]?.url).toBe(`https://returnyoutubedislikeapi.com/votes?videoId=${VIDEO}`);
    expect(page.calls[0]?.init).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    page.tick();
    expect(page.host.children).toHaveLength(1);
    expect(page.host.children[0]?.textContent).toBe("12.3K");
  });

  it("shows nothing for a malformed answer", async () => {
    const page = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => ({
      ok: true,
      body: { dislikes: "many" },
    }));
    page.run([DISLIKES]);
    await flush();
    page.tick();
    expect(page.host.children).toHaveLength(0);
  });

  it("removes what it added when the rules are switched off", async () => {
    const page = open(`https://www.youtube.com/watch?v=${VIDEO}`, () => ({
      ok: true,
      body: { dislikes: 7 },
    }));
    page.run([DISLIKES]);
    await flush();
    page.tick();
    expect(page.host.children).toHaveLength(1);
    page.run([]);
    expect(page.host.children).toHaveLength(0);
    expect(page.calls).toHaveLength(1);
  });
});
