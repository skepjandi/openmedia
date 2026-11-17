import { describe, expect, it } from "vitest";
import {
  LIMIT_STOPS,
  limitedThings,
  limitSites,
  limitStatus,
  policyKeyFor,
  reconcile,
  secondsUntilMidnight,
  siteParts,
  stopsFor,
  suggestedWarn,
  suggestHosts,
  thresholdsOf,
  warnStops,
  withPreset,
} from "./limits";
import { NO_LIMITS } from "./policy";

describe("slider stops", () => {
  it("keeps a saved value that is not a stop so its thumb can sit on it", () => {
    expect(stopsFor(7, null)).toContain(7);
    expect(stopsFor(7, null)).toEqual([...stopsFor(7, null)].sort((a, b) => a - b));
    expect(stopsFor(60, null)).toEqual(LIMIT_STOPS);
  });

  it("never lets a reminder reach a full day, so a limit always fits above it", () => {
    expect(Math.max(...warnStops(LIMIT_STOPS))).toBeLessThan(1440);
  });

  it("reads policies in whole minutes and treats missing thresholds as off", () => {
    expect(thresholdsOf({ warnSeconds: 2700, limitSeconds: 3600 })).toEqual({
      warn: 45,
      limit: 60,
    });
    expect(thresholdsOf({ warnSeconds: null, limitSeconds: 600 })).toEqual({
      warn: null,
      limit: 10,
    });
    expect(thresholdsOf(undefined)).toEqual({ warn: null, limit: null });
  });
});

describe("reconcile", () => {
  const stops = LIMIT_STOPS;

  it("leaves a valid pair alone", () => {
    expect(reconcile("limit", { warn: 45, limit: 60 }, stops)).toEqual({ warn: 45, limit: 60 });
    expect(reconcile("warn", { warn: 30, limit: null }, stops)).toEqual({ warn: 30, limit: null });
  });

  it("pulls the reminder below a limit dragged under it", () => {
    expect(reconcile("limit", { warn: 45, limit: 30 }, stops)).toEqual({ warn: 25, limit: 30 });
    expect(reconcile("limit", { warn: 45, limit: 45 }, stops)).toEqual({ warn: 30, limit: 45 });
  });

  it("pushes the limit above a reminder dragged over it", () => {
    expect(reconcile("warn", { warn: 90, limit: 60 }, stops)).toEqual({ warn: 90, limit: 105 });
  });

  it("drops the reminder when no stop is left below the smallest limit", () => {
    expect(reconcile("limit", { warn: 10, limit: 5 }, stops)).toEqual({ warn: null, limit: 5 });
  });
});

describe("presets", () => {
  it("suggests a reminder at about three quarters of the limit, on a stop", () => {
    expect(suggestedWarn(60, LIMIT_STOPS)).toBe(45);
    expect(suggestedWarn(30, LIMIT_STOPS)).toBe(20);
    expect(suggestedWarn(120, LIMIT_STOPS)).toBe(90);
    expect(suggestedWarn(5, LIMIT_STOPS)).toBeNull();
  });

  it("always produces a reminder before the limit", () => {
    for (const minutes of LIMIT_STOPS) {
      const { warn, limit } = withPreset(minutes);
      expect(warn === null || warn < (limit ?? 0)).toBe(true);
    }
  });
});

describe("limitStatus", () => {
  const both = { warnSeconds: 45 * 60, limitSeconds: 60 * 60 };

  it("moves from ok to warned to reached exactly at the thresholds", () => {
    expect(limitStatus(both, 45 * 60 - 1).state).toBe("ok");
    expect(limitStatus(both, 45 * 60).state).toBe("warned");
    expect(limitStatus(both, 60 * 60 - 1).state).toBe("warned");
    expect(limitStatus(both, 60 * 60).state).toBe("reached");
  });

  it("measures the meter against the limit and places the reminder on it", () => {
    const status = limitStatus(both, 30 * 60);
    expect(status.fraction).toBe(0.5);
    expect(status.warnFraction).toBe(0.75);
    expect(status.untilLimit).toBe(30 * 60);
    expect(status.untilWarn).toBe(15 * 60);
  });

  it("never reports negative time left or a meter past full", () => {
    const status = limitStatus(both, 5 * 3600);
    expect(status.fraction).toBe(1);
    expect(status.untilLimit).toBe(0);
    expect(status.untilWarn).toBe(0);
  });

  it("measures a reminder-only policy against the reminder and never reaches a limit", () => {
    const status = limitStatus({ warnSeconds: 600, limitSeconds: null }, 900);
    expect(status).toMatchObject({ state: "warned", fraction: 1, warnFraction: null });
    expect(status.untilLimit).toBeNull();
  });

  it("has nothing to show without a policy", () => {
    expect(limitStatus(undefined, 100).state).toBe("none");
    expect(limitStatus({ warnSeconds: null, limitSeconds: null }, 100).state).toBe("none");
  });

  it("ignores fractional seconds the tracker keeps", () => {
    expect(limitStatus(both, 3599.9).state).toBe("warned");
  });
});

describe("secondsUntilMidnight", () => {
  it("counts to the next local midnight", () => {
    expect(secondsUntilMidnight(new Date(2026, 10, 8, 23, 59, 30))).toBe(30);
    expect(secondsUntilMidnight(new Date(2026, 10, 8, 0, 0, 0))).toBe(86_400);
  });
});

describe("limit sites", () => {
  const favorites = [
    { name: "YouTube", url: "https://m.youtube.com/" },
    { name: "Reddit", url: "https://www.reddit.com/" },
    { name: "YouTube again", url: "https://www.youtube.com/watch" },
  ];

  it("lists favorites once per site, in order, then other limited or added sites", () => {
    const policies = {
      "reddit.com": { warnSeconds: null, limitSeconds: 600 },
      "news.test": { warnSeconds: null, limitSeconds: 600 },
    };
    expect(limitSites(favorites, policies, ["blog.test", "news.test"])).toEqual({
      favorites: [
        { host: "youtube.com", name: "YouTube" },
        { host: "reddit.com", name: "Reddit" },
      ],
      others: [
        { host: "news.test", name: null },
        { host: "blog.test", name: null },
      ],
    });
  });

  it("finds the saved limit that governs a subdomain, and falls back to the host", () => {
    const policies = { "example.com": { warnSeconds: null, limitSeconds: 60 } };
    expect(policyKeyFor(policies, "m.example.com")).toBe("example.com");
    expect(policyKeyFor(policies, "notexample.com")).toBe("notexample.com");
  });
});

describe("parts of a site", () => {
  it("lists the parts used recently and the ones that carry a limit", () => {
    const sections = { "example.com": { "/watch": { warnSeconds: null, limitSeconds: 600 } } };
    expect(siteParts("example.com", ["/", "/watch"], sections)).toEqual(["/", "/watch"]);
    expect(siteParts("other.test", ["/"], sections)).toEqual(["/"]);
  });

  it("lists every limited site and part, closest to its limit first", () => {
    const limits = {
      ...NO_LIMITS,
      sites: { "a.test": { warnSeconds: null, limitSeconds: 600 } },
      sections: {
        "b.test": { "/watch": { warnSeconds: null, limitSeconds: 60 } },
      },
    };
    const things = limitedThings(
      limits,
      { "a.test": 300, "b.test": 30 },
      { "b.test": { "/watch": 30 } },
    );
    expect(things.map((thing) => `${thing.host}${thing.section ?? ""}`)).toEqual([
      "a.test",
      "b.test/watch",
    ]);
    expect(things[1].spent).toBe(30);
  });

  it("leaves out the limits that are off", () => {
    const things = limitedThings(
      { ...NO_LIMITS, sites: { "a.test": { warnSeconds: 60, limitSeconds: null } } },
      { "a.test": 10 },
      {},
    );
    expect(things).toHaveLength(1);
    expect(things[0].status.state).toBe("ok");
  });
});

describe("suggestHosts", () => {
  it("offers today's busiest sites before recent addresses, skipping taken and repeats", () => {
    const suggestions = suggestHosts(
      ["https://www.a.test/x", "b.test", "not an address", "c.test"],
      { "c.test": 50, "b.test": 10, "taken.test": 999 },
      new Set(["taken.test", "a.test"]),
    );
    expect(suggestions).toEqual(["c.test", "b.test"]);
  });

  it("caps the list", () => {
    const history = Array.from({ length: 20 }, (_, index) => `site${index}.test`);
    expect(suggestHosts(history, {}, new Set(), 3)).toHaveLength(3);
  });
});
