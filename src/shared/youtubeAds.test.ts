import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("../../blocklists/openmedia-youtube-ads.js", import.meta.url),
  "utf8",
);

const PLAYER_WITH_ADS = {
  videoDetails: { videoId: "abc" },
  adPlacements: [{ adPlacementRenderer: {} }],
  playerAds: [{}],
  adSlots: [{}],
  streamingData: { formats: [] },
};

function load(fetchImpl?: (input: unknown) => Promise<Response>) {
  const timers: Array<() => void> = [];
  const win: Record<string, unknown> = {
    fetch: fetchImpl ?? (() => Promise.resolve(new Response("{}"))),
    Response,
    top: undefined,
  };
  win.window = win;
  win.top = win;
  win.document = { querySelector: () => null };
  win.setInterval = (fn: () => void) => timers.push(fn);
  win.XMLHttpRequest = class {
    open() {}
  };
  const context = vm.createContext(win);
  vm.runInContext(SOURCE, context);
  return { win, context };
}

describe("openmedia-youtube-ads scriptlet", () => {
  it("removes the ad lists from a JSON.parse result and leaves the rest", () => {
    const { context } = load();
    const parsed = vm.runInContext(
      `JSON.parse(${JSON.stringify(JSON.stringify(PLAYER_WITH_ADS))})`,
      context,
    );
    expect(Object.keys(parsed)).toEqual(["videoDetails", "streamingData"]);
  });

  it("prunes data the page assigns to ytInitialPlayerResponse", () => {
    const { context } = load();
    const keys = vm.runInContext(
      `var ytInitialPlayerResponse = ${JSON.stringify(PLAYER_WITH_ADS)}; Object.keys(ytInitialPlayerResponse)`,
      context,
    );
    expect(keys).toEqual(["videoDetails", "streamingData"]);
  });

  it("strips ads from a youtubei fetch response and keeps other requests untouched", async () => {
    const body = JSON.stringify(PLAYER_WITH_ADS);
    const { win } = load(() => Promise.resolve(new Response(body, { status: 200 })));
    const fetch = win.fetch as (input: string) => Promise<Response>;
    const pruned = await (await fetch("https://m.youtube.com/youtubei/v1/player?x=1")).json();
    expect(Object.keys(pruned)).toEqual(["videoDetails", "streamingData"]);
    const other = await (await fetch("https://m.youtube.com/watch")).json();
    expect(Object.keys(other)).toContain("adPlacements");
  });

  it("drops ad tiles from feeds and ad entries from the Shorts sequence", async () => {
    const feed = {
      contents: [
        { richItemRenderer: { content: { videoRenderer: { videoId: "a" } } } },
        { richItemRenderer: { content: { adSlotRenderer: {} } } },
        { adSlotRenderer: {} },
      ],
      reelWatchSequenceResponse: {
        entries: [
          { command: { reelWatchEndpoint: { videoId: "s1", adClientParams: { isAd: true } } } },
          { command: { reelWatchEndpoint: { videoId: "s2" } } },
        ],
      },
    };
    const { win } = load(() => Promise.resolve(new Response(JSON.stringify(feed))));
    const fetch = win.fetch as (input: string) => Promise<Response>;
    const pruned = (await (
      await fetch("https://m.youtube.com/youtubei/v1/reel/reel_watch_sequence")
    ).json()) as typeof feed;
    expect(pruned.contents).toHaveLength(1);
    expect(pruned.reelWatchSequenceResponse.entries).toHaveLength(1);
    expect(pruned.reelWatchSequenceResponse.entries[0]?.command.reelWatchEndpoint.videoId).toBe(
      "s2",
    );
  });

  it("returns the original response when a failure happens while pruning", async () => {
    const { win } = load(() => Promise.resolve(new Response("adPlacements not json")));
    const fetch = win.fetch as (input: string) => Promise<Response>;
    expect(await (await fetch("https://www.youtube.com/youtubei/v1/player")).text()).toBe(
      "adPlacements not json",
    );
  });
});
