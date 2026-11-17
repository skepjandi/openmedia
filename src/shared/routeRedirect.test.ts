import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("../../src-tauri/src/route_redirect.js", import.meta.url),
  "utf8",
);

interface Rule {
  key: string;
  matchers: { scheme: string; host: string; path: string }[];
  regex: string;
  negate: boolean;
  to: string;
}

/** What `compile.rs` emits for `{ "match": "https://www.youtube.com/*", "when": { "path": "/shorts/**" }, "to": "/" }`. */
const SHORTS: Rule = {
  key: "youtube/shorts-route",
  matchers: [{ scheme: "https", host: "^www\\.youtube\\.com$", path: "^/.*$" }],
  regex: "^/shorts(?:/.*)?$",
  negate: false,
  to: "/",
};

type Listener = () => void;

interface Page {
  replaced: string[];
  location: { href: string; pathname: string };
  push: (path: string) => void;
  replaceState: (path: string) => void;
  fire: (type: "popstate" | "hashchange") => void;
  clock: { now: number };
  storage: Map<string, string>;
}

/** A page at `href` with the pieces of `window` the runtime touches; the site can also navigate it. */
function openPage(
  href: string,
  rules: Rule[],
  options: { storage?: Map<string, string>; top?: boolean; clock?: { now: number } } = {},
): Page {
  const storage = options.storage ?? new Map<string, string>();
  const clock = options.clock ?? { now: 1_000 };
  const replaced: string[] = [];
  const listeners: Record<string, Listener[]> = {};
  const location = {
    href: "",
    protocol: "",
    hostname: "",
    pathname: "",
    origin: "",
    replace(next: string) {
      replaced.push(next);
      go(next);
    },
  };
  const go = (next: string) => {
    const url = new URL(next, location.href || href);
    Object.assign(location, {
      href: url.href,
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      origin: url.origin,
    });
  };
  go(href);
  const history = {
    pushState: (_state: unknown, _title: string, path: string) => go(path),
    replaceState: (_state: unknown, _title: string, path: string) => go(path),
  };
  const window: Record<string, unknown> = {
    location,
    history,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
    addEventListener: (type: string, listener: Listener) => {
      (listeners[type] ??= []).push(listener);
    },
  };
  window.top = options.top === false ? {} : window;
  const sandbox = vm.createContext({ window, URL, Date: { now: () => clock.now } });
  (vm.runInContext(`(${SOURCE})`, sandbox) as (rules: Rule[]) => void)(rules);
  return {
    replaced,
    location,
    push: (path) => history.pushState(null, "", path),
    replaceState: (path) => history.replaceState(null, "", path),
    fire: (type) => listeners[type]?.forEach((listener) => listener()),
    clock,
    storage,
  };
}

describe("route_redirect.js", () => {
  it("sends a guarded address to the target on load, replacing it in history", () => {
    const page = openPage("https://www.youtube.com/shorts/abc?feature=share", [SHORTS]);
    expect(page.replaced).toEqual(["https://www.youtube.com/"]);
    expect(page.location.pathname).toBe("/");
  });

  it("covers the bare prefix and a deep path of an open-ended glob", () => {
    expect(openPage("https://www.youtube.com/shorts", [SHORTS]).replaced).toHaveLength(1);
    expect(openPage("https://www.youtube.com/shorts/a/b", [SHORTS]).replaced).toHaveLength(1);
  });

  it("leaves other paths, other sites and other schemes alone", () => {
    expect(openPage("https://www.youtube.com/watch?v=1", [SHORTS]).replaced).toEqual([]);
    expect(openPage("https://www.youtube.com/shortsfeed", [SHORTS]).replaced).toEqual([]);
    expect(openPage("https://example.com/shorts/abc", [SHORTS]).replaced).toEqual([]);
    expect(openPage("http://www.youtube.com/shorts/abc", [SHORTS]).replaced).toEqual([]);
  });

  it("does nothing without rules, as when the option is off", () => {
    expect(openPage("https://www.youtube.com/shorts/abc", []).replaced).toEqual([]);
  });

  it("redirects on a single-page navigation by pushState, replaceState, popstate and hashchange", () => {
    const page = openPage("https://www.youtube.com/", [SHORTS]);
    expect(page.replaced).toEqual([]);

    page.push("/shorts/one");
    expect(page.replaced).toEqual(["https://www.youtube.com/"]);

    page.clock.now += 5_000;
    page.replaceState("/shorts/two");
    expect(page.replaced).toHaveLength(2);

    page.clock.now += 5_000;
    Object.assign(page.location, {
      pathname: "/shorts/three",
      href: "https://www.youtube.com/shorts/three",
    });
    page.fire("popstate");
    expect(page.replaced).toHaveLength(3);

    page.clock.now += 5_000;
    Object.assign(page.location, {
      pathname: "/shorts/four",
      href: "https://www.youtube.com/shorts/four#x",
    });
    page.fire("hashchange");
    expect(page.replaced).toHaveLength(4);
  });

  it("leaves an ordinary single-page navigation alone", () => {
    const page = openPage("https://www.youtube.com/", [SHORTS]);
    page.push("/watch?v=1");
    expect(page.replaced).toEqual([]);
    expect(page.location.pathname).toBe("/watch");
  });

  it("treats a leading bang as every path but the glob", () => {
    const only: Rule = {
      ...SHORTS,
      key: "a/only",
      regex: "^/app(?:/.*)?$",
      negate: true,
      to: "/app/",
    };
    expect(openPage("https://www.youtube.com/login", [only]).replaced).toEqual([
      "https://www.youtube.com/app/",
    ]);
    expect(openPage("https://www.youtube.com/app/x", [only]).replaced).toEqual([]);
  });

  it("stops a rule that keeps being sent back, after three redirects in a second", () => {
    const page = openPage("https://www.youtube.com/", [SHORTS]);
    for (let i = 0; i < 10; i++) page.push("/shorts/bounce");
    expect(page.replaced).toHaveLength(3);
    expect(page.location.pathname).toBe("/shorts/bounce");
  });

  it("keeps a suspended rule suspended after a reload of the document", () => {
    const first = openPage("https://www.youtube.com/", [SHORTS]);
    for (let i = 0; i < 10; i++) first.push("/shorts/bounce");
    const next = openPage("https://www.youtube.com/shorts/bounce", [SHORTS], {
      storage: first.storage,
      clock: first.clock,
    });
    expect(next.replaced).toEqual([]);
    next.clock.now += 60_000;
    next.push("/shorts/later");
    expect(next.replaced).toEqual([]);
  });

  it("counts each rule on its own", () => {
    const other: Rule = { ...SHORTS, key: "youtube/clips-route", regex: "^/clips(?:/.*)?$" };
    const page = openPage("https://www.youtube.com/", [SHORTS, other]);
    for (let i = 0; i < 5; i++) page.push("/shorts/bounce");
    page.push("/clips/one");
    expect(page.replaced).toHaveLength(4);
  });

  it("refuses a target that leaves the site", () => {
    for (const to of ["https://evil.example/", "//evil.example/", "javascript:alert(1)"]) {
      const page = openPage("https://www.youtube.com/shorts/abc", [{ ...SHORTS, to }]);
      expect(page.replaced, to).toEqual([]);
    }
  });

  it("only redirects the top frame", () => {
    expect(
      openPage("https://www.youtube.com/shorts/abc", [SHORTS], { top: false }).replaced,
    ).toEqual([]);
  });
});
