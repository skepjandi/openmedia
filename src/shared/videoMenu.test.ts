import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(new URL("../../src-tauri/src/video_menu.js", import.meta.url), "utf8");

interface Entry {
  textContent: string;
  attributes: Record<string, string>;
  classList: { contains: (name: string) => boolean };
  getAttribute: (name: string) => string | null;
  dispatchEvent: (event: { type: string }) => void;
}

function entry(
  text: string,
  attributes: Record<string, string> = {},
  classes: string[] = [],
  onClick: () => void = () => {},
): Entry {
  return {
    textContent: text,
    attributes,
    classList: { contains: (name) => classes.includes(name) },
    getAttribute: (name) => attributes[name] ?? null,
    dispatchEvent: (event) => {
      if (event.type === "click") onClick();
    },
  };
}

interface Rule {
  kind: string;
  title: string;
  open: string[];
  items: string;
  selected: { attr?: string; class?: string };
  close: string | null;
}

const QUALITY: Rule = {
  kind: "quality",
  title: "Quality",
  open: [".gear", ".quality-entry"],
  items: ".level",
  selected: { attr: "aria-checked" },
  close: null,
};

/** A player menu that opens in two steps, the way many sites' settings do. */
function player(options: { gear?: boolean; open?: boolean } = {}) {
  const picked: number[] = [];
  const clicks: string[] = [];
  let step = options.open ? 2 : 0;
  let current = 1;
  const levels = () =>
    ["Auto", "720p", "1080p"].map((text, index) =>
      entry(text, { "aria-checked": String(index === current) }, [], () => {
        picked.push(index);
        current = index;
        step = 0;
      }),
    );
  const gear = entry("", {}, [], () => {
    clicks.push("gear");
    step = step === 0 ? 1 : 0;
  });
  const quality = entry("Quality", {}, [], () => {
    clicks.push("quality");
    step = 2;
  });
  const document: Record<string | symbol, unknown> = {
    querySelectorAll: (css: string) => {
      if (css === ".gear") return options.gear === false ? [] : [gear];
      if (css === ".quality-entry") return step >= 1 ? [quality] : [];
      if (css === ".level") return step >= 2 ? levels() : [];
      throw new Error("bad selector");
    },
  };
  return { document, picked, clicks };
}

function start(rules: Rule[], world: ReturnType<typeof player>) {
  class Mouse {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  const win: Record<string, unknown> = {
    document: world.document,
    MouseEvent: Mouse,
    Promise,
    Date,
    Array,
    String,
    Symbol,
    setTimeout,
    clearTimeout,
  };
  win.window = win;
  const context = vm.createContext({ ...win, document: world.document, window: win });
  const run = vm.runInContext(`(${SOURCE.trim()})`, context) as (rules: Rule[]) => void;
  run(rules);
  return world.document[Symbol.for("openmedia.videoMenus")] as (video: unknown) => Array<{
    kind: string;
    label: string;
    items: Array<{ label: string; selected: boolean }>;
    select: (index: number) => void;
  }>;
}

describe("video menus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the site's menu once, reads its entries and offers them as a group", async () => {
    const world = player();
    const provider = start([QUALITY], world);
    const video = { currentSrc: "a" };
    expect(provider(video)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    const [group] = provider(video);
    expect(group?.kind).toBe("quality");
    expect(group?.label).toBe("Quality");
    expect(group?.items).toEqual([
      { label: "Auto", selected: false },
      { label: "720p", selected: true },
      { label: "1080p", selected: false },
    ]);
    // It opened the menu by clicking the gear then the entry, and closed it again with the gear.
    expect(world.clicks).toEqual(["gear", "quality", "gear"]);
    // The video has not changed, so asking again does not open the menu again.
    await vi.advanceTimersByTimeAsync(5000);
    provider(video);
    await vi.advanceTimersByTimeAsync(1500);
    expect(world.clicks).toEqual(["gear", "quality", "gear"]);
  });

  it("picks an entry by opening the menu again and clicking it", async () => {
    const world = player();
    const provider = start([QUALITY], world);
    const video = { currentSrc: "a" };
    provider(video);
    await vi.advanceTimersByTimeAsync(1500);
    provider(video)[0]?.select(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(world.picked).toEqual([2]);
    // The next read sees the new state of the player.
    provider(video);
    await vi.advanceTimersByTimeAsync(1500);
    expect(provider(video)[0]?.items.map((item) => item.selected)).toEqual([false, false, true]);
  });

  it("reads a menu the person has open themselves, without clicking", () => {
    const world = player({ open: true });
    const provider = start([QUALITY], world);
    expect(provider({ currentSrc: "a" })[0]?.items).toHaveLength(3);
    expect(world.clicks).toEqual([]);
  });

  it("offers nothing when the site's menu cannot be opened", async () => {
    const world = player({ gear: false });
    const provider = start([QUALITY], world);
    provider({ currentSrc: "a" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(provider({ currentSrc: "a" })).toEqual([]);
  });

  it("knows the entry in use by a class as well as by an attribute", async () => {
    const world = player({ open: true });
    const original = world.document.querySelectorAll as (css: string) => Entry[];
    world.document.querySelectorAll = (css: string) =>
      css === ".level" ? [entry("Auto"), entry("720p", {}, ["on"]), entry("1080p")] : original(css);
    const provider = start([{ ...QUALITY, selected: { class: "on" } }], world);
    expect(provider({ currentSrc: "a" })[0]?.items.map((item) => item.selected)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
