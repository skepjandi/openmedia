import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const report = vi.fn(async (day: string) => {
  const sites = [...(ledger.get(day) ?? new Map())].map(([host, sections]) => ({
    host,
    name: null,
    seconds: [...sections.values()].reduce((sum, seconds) => sum + seconds, 0),
    sections: [...sections].map(([section, seconds]) => ({ section, seconds })),
  }));
  return { totalSeconds: sites.reduce((sum, site) => sum + site.seconds, 0), sites };
});
const ledger = new Map<string, Map<string, Map<string, number>>>();
vi.mock("../../shared/ipc", () => ({
  errorMessage: (error: unknown) => String(error),
  usage: {
    record: (day: string, host: string, section: string, seconds: number) => {
      let sites = ledger.get(day);
      if (!sites) ledger.set(day, (sites = new Map()));
      let sections = sites.get(host);
      if (!sections) sites.set(host, (sections = new Map()));
      sections.set(section, (sections.get(section) ?? 0) + seconds);
      return Promise.resolve();
    },
    report: (day: string) => report(day),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useApp } from "../../app/store";
import type { Session } from "../web/sessions";
import { settleUsageWrites, startUsageTracking } from "./tracker";
import { localDay } from "./format";
import { NO_LIMITS, usageLimits, useUsageControl } from "./policy";
import { useEntitlementStore } from "../paywall/store";

const policies = {
  "example.com": { warnSeconds: 2, limitSeconds: 3 },
  "other.test": { warnSeconds: null, limitSeconds: 20 },
};
const session = (id: string, url: string, scope: string): Session => ({
  id,
  source: "typed",
  hubId: null,
  openedUrl: url,
  scope,
  url,
  title: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  playing: false,
  restoredBack: [],
  painted: true,
  lastUsed: Date.now(),
  openedAt: 0,
  paintMs: null,
  loadStartedAt: null,
  loadMs: null,
});
const flushMicrotasks = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

let stop: (() => void) | undefined;
let documentTarget: EventTarget;
let visibility = "visible";
let windowTarget: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 8, 12, 0, 0));
  ledger.clear();
  vi.spyOn(usageLimits, "get").mockResolvedValue({ ...NO_LIMITS, sites: policies });
  documentTarget = new EventTarget();
  windowTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", { get: () => visibility });
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal(
    "window",
    Object.assign(windowTarget, {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    }),
  );
  visibility = "visible";
  useApp.setState({
    sessions: [session("example", "https://example.com/", "example.com")],
    activeId: "example",
    sheet: "none",
    onboardingOpen: false,
  });
  useUsageControl.setState({
    day: localDay(new Date()),
    limits: NO_LIMITS,
    seconds: {},
    sectionSeconds: {},
    ready: false,
    warning: null,
  });
  useEntitlementStore.setState({ status: "pro", configured: true, snapshot: null });
});

afterEach(async () => {
  stop?.();
  stop = undefined;
  await settleUsageWrites();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function start() {
  stop = startUsageTracking();
  await flushMicrotasks();
}

async function tick(seconds: number) {
  await vi.advanceTimersByTimeAsync(seconds * 1_000);
}

describe("usage tracking", () => {
  it("does not request or expose Usage for a free user", async () => {
    report.mockClear();
    useEntitlementStore.setState({ status: "free", configured: true, snapshot: null });
    await start();
    await tick(3);
    expect(usageLimits.get).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(useUsageControl.getState().ready).toBe(false);
    expect(useApp.getState().sheet).toBe("none");
  });

  it("stops at a site's limit and resumes counting on an unrelated site", async () => {
    await start();
    await tick(4);
    expect(useUsageControl.getState().seconds["example.com"]).toBe(3);
    expect(useUsageControl.getState().ready).toBe(true);

    useApp.setState({
      sessions: [
        session("example", "https://example.com/", "example.com"),
        session("other", "https://other.test/", "other.test"),
      ],
      activeId: "other",
    });
    await tick(2);
    await settleUsageWrites();
    expect(useUsageControl.getState().seconds).toMatchObject({ "example.com": 3, "other.test": 2 });
    expect(ledger.get(localDay(new Date()))?.get("other.test")?.get("/")).toBe(2);
    expect(ledger.get(localDay(new Date()))?.get("example.com")?.get("/")).toBe(3);
  });

  it("stops counting a part at its limit while the rest of the site keeps counting", async () => {
    vi.spyOn(usageLimits, "get").mockResolvedValue({
      ...NO_LIMITS,
      sections: { "example.com": { "/watch": { warnSeconds: null, limitSeconds: 2 } } },
    });
    useApp.setState({
      sessions: [session("example", "https://example.com/watch", "example.com")],
      activeId: "example",
    });
    await start();
    await tick(4);
    await settleUsageWrites();
    expect(useUsageControl.getState().sectionSeconds["example.com"]?.["/watch"]).toBe(2);
    expect(useUsageControl.getState().seconds["example.com"]).toBe(2);
    expect(ledger.get(localDay(new Date()))?.get("example.com")?.get("/watch")).toBe(2);

    useApp.setState({
      sessions: [session("example", "https://example.com/feed", "example.com")],
      activeId: "example",
    });
    await tick(2);
    await settleUsageWrites();
    expect(useUsageControl.getState().sectionSeconds["example.com"]?.["/watch"]).toBe(2);
    expect(useUsageControl.getState().seconds["example.com"]).toBeGreaterThan(2);
  });

  it("splits elapsed foreground time across local midnight", async () => {
    vi.setSystemTime(new Date(2026, 10, 8, 23, 59, 59));
    vi.spyOn(usageLimits, "get").mockResolvedValue(NO_LIMITS);
    useUsageControl.setState({
      day: localDay(new Date()),
      limits: NO_LIMITS,
      seconds: {},
      sectionSeconds: {},
      ready: false,
      warning: null,
    });
    await start();
    await tick(2);
    await settleUsageWrites();

    const previousDay = localDay(new Date(2026, 10, 8, 12));
    const newDay = localDay(new Date(2026, 10, 9, 12));
    expect(ledger.get(previousDay)?.get("example.com")?.get("/")).toBe(1);
    expect(ledger.get(newDay)?.get("example.com")?.get("/")).toBe(1);
    expect(useUsageControl.getState()).toMatchObject({
      day: newDay,
      seconds: { "example.com": 1 },
    });
  });

  it("restores an exhausted allowance when the clock returns to a recorded date", async () => {
    const previousDay = localDay(new Date(2026, 10, 7, 12));
    ledger.set(previousDay, new Map([["example.com", new Map([["/", 3]])]]));
    await start();
    await tick(1);
    vi.setSystemTime(new Date(2026, 10, 7, 12));
    await tick(1);
    expect(useUsageControl.getState()).toMatchObject({
      day: previousDay,
      ready: true,
      seconds: { "example.com": 3 },
    });
    await tick(2);
    expect(useUsageControl.getState().seconds["example.com"]).toBe(3);
  });

  it("pauses while a sheet is open and resumes only foreground page time", async () => {
    await start();
    await tick(1);
    useApp.setState({ sheet: "stats" });
    await tick(3);
    useApp.setState({ sheet: "none" });
    await tick(1);
    visibility = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await tick(4);
    visibility = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await tick(1);
    stop?.();
    stop = undefined;
    await settleUsageWrites();

    expect(useUsageControl.getState().seconds["example.com"]).toBe(3);
    expect(ledger.get(localDay(new Date()))?.get("example.com")?.get("/")).toBe(3);
  });
});
