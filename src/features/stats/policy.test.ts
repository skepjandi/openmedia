import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closesSite,
  isUsageBlocked,
  pageLock,
  limitReached,
  NO_LIMITS,
  policyForHost,
  policyForSection,
  sectionUsageSeconds,
  useUsageControl,
} from "./policy";

const policies = {
  "example.com": { warnSeconds: 60, limitSeconds: 120 },
  "other.test": { warnSeconds: null, limitSeconds: 600 },
};

const sectionPolicies = {
  "example.com": { "/watch": { warnSeconds: 30, limitSeconds: 90 } },
};

const empty = { limits: NO_LIMITS, seconds: {}, sectionSeconds: {} };

afterEach(() => useUsageControl.setState({ ...empty, ready: false }));

describe("daily site limits", () => {
  it("blocks at the exact boundary, not the warning, and keeps unrelated sites open", () => {
    useUsageControl.setState({
      limits: { ...NO_LIMITS, sites: policies },
      seconds: { "example.com": 119, "other.test": 50 },
      ready: true,
    });
    expect(isUsageBlocked("example.com")).toBe(false);
    useUsageControl.setState({ seconds: { "example.com": 120, "other.test": 50 } });
    expect(isUsageBlocked("example.com")).toBe(true);
    expect(isUsageBlocked("other.test")).toBe(false);
    expect(isUsageBlocked("unknown.test")).toBe(false);
  });

  it("applies parent site limits to mobile subdomains without matching lookalike domains", () => {
    expect(limitReached(policyForHost(policies, "m.example.com"), 120)).toBe(true);
    expect(policyForHost(policies, "notexample.com")).toBeUndefined();
  });

  it("matches a configured www host to the native registrable-domain scope", () => {
    expect(policyForHost({ "www.example.com": policies["example.com"] }, "example.com")).toEqual(
      policies["example.com"],
    );
  });

  it("keeps warning-only policies unblocked and lifts limits when today's totals reset", () => {
    expect(limitReached({ warnSeconds: 60, limitSeconds: null }, 90_000)).toBe(false);
    useUsageControl.setState({
      limits: { ...NO_LIMITS, sites: policies },
      seconds: { "example.com": 120 },
      ready: true,
    });
    expect(isUsageBlocked("example.com")).toBe(true);
    useUsageControl.setState({ day: "2026-11-09", seconds: {} });
    expect(isUsageBlocked("example.com")).toBe(false);
  });
});

describe("daily part limits", () => {
  it("finds the limit of one part and leaves the other parts of the site alone", () => {
    expect(policyForSection(sectionPolicies, "example.com", "/watch")).toEqual(
      sectionPolicies["example.com"]["/watch"],
    );
    expect(policyForSection(sectionPolicies, "example.com", "/shorts")).toBeUndefined();
    expect(policyForSection(sectionPolicies, "other.test", "/watch")).toBeUndefined();
  });

  it("covers the domains around the site, but not a lookalike domain", () => {
    expect(policyForSection(sectionPolicies, "m.example.com", "/watch")).toEqual(
      sectionPolicies["example.com"]["/watch"],
    );
    expect(policyForSection(sectionPolicies, "notexample.com", "/watch")).toBeUndefined();
  });

  it("adds up the time of a part across the domains around the site", () => {
    const sectionSeconds = { "example.com": { "/watch": 30 }, "m.example.com": { "/watch": 20 } };
    expect(sectionUsageSeconds(sectionSeconds, "example.com", "/watch")).toBe(50);
    expect(sectionUsageSeconds(sectionSeconds, "example.com", "/shorts")).toBe(0);
  });

  it("blocks only the part that is over its limit", () => {
    const sectionSeconds = { "example.com": { "/watch": 90, "/shorts": 60 } };
    const spent = (section: string) => sectionUsageSeconds(sectionSeconds, "example.com", section);
    expect(
      limitReached(policyForSection(sectionPolicies, "example.com", "/watch"), spent("/watch")),
    ).toBe(true);
    expect(
      limitReached(policyForSection(sectionPolicies, "example.com", "/shorts"), spent("/shorts")),
    ).toBe(false);
  });
});

describe("pageLock", () => {
  const limits = {
    ...NO_LIMITS,
    sites: { "example.com": { warnSeconds: null, limitSeconds: 100 } },
    sections: { "example.com": { "/reels": { warnSeconds: null, limitSeconds: 10 } } },
  };
  const sectionSeconds = { "example.com": { "/reels": 12, "/": 5 } };

  it("closes only the part that is over its own limit", () => {
    const seconds = { "example.com": 17 };
    expect(
      pageLock(limits, seconds, sectionSeconds, { host: "example.com", section: "/reels" }),
    ).toEqual({
      kind: "part",
      spent: 12,
    });
    expect(
      pageLock(limits, seconds, sectionSeconds, { host: "example.com", section: "/" }),
    ).toBeNull();
  });

  it("closes every part once the whole site is over", () => {
    expect(
      pageLock(limits, { "example.com": 100 }, sectionSeconds, {
        host: "example.com",
        section: "/",
      }),
    ).toEqual({ kind: "site", spent: 100 });
  });
});

describe("downtime schedules", () => {
  const night = { windows: [{ days: 0b111_1111, startMinute: 22 * 60, endMinute: 7 * 60 }] };
  const limits = { ...NO_LIMITS, schedules: { "example.com": night } };
  const target = { host: "example.com", section: "/" };

  it("closes the whole site inside a window that crosses midnight, and says when it opens", () => {
    const late = new Date(2026, 0, 5, 23, 30);
    const lock = pageLock(limits, {}, {}, target, late);
    expect(lock?.kind).toBe("schedule");
    expect(lock?.kind === "schedule" && lock.opensAt?.getHours()).toBe(7);
    expect(closesSite(lock)).toBe(true);
    expect(pageLock(limits, {}, {}, target, new Date(2026, 0, 6, 6, 59))?.kind).toBe("schedule");
  });

  it("leaves the site open outside the window", () => {
    expect(pageLock(limits, {}, {}, target, new Date(2026, 0, 5, 7, 0))).toBeNull();
  });

  it("applies to subdomains and not to lookalike domains", () => {
    const late = new Date(2026, 0, 5, 23, 30);
    expect(pageLock(limits, {}, {}, { host: "m.example.com", section: "/" }, late)?.kind).toBe(
      "schedule",
    );
    expect(pageLock(limits, {}, {}, { host: "notexample.com", section: "/" }, late)).toBeNull();
  });

  it("stops time counting while closed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 23, 30));
    useUsageControl.setState({ limits, ready: true });
    expect(isUsageBlocked("example.com")).toBe(true);
    vi.setSystemTime(new Date(2026, 0, 6, 12, 0));
    expect(isUsageBlocked("example.com")).toBe(false);
    vi.useRealTimers();
  });
});
