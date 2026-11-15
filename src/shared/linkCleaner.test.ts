import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(new URL(`../../blocklists/${name}`, import.meta.url), "utf8");

const SOURCE = read("openmedia-link-cleaner.js");
// The shape Rust builds in `link_clean.rs`: Brave's three data sets, joined.
const RULES = {
  strip: [
    ...JSON.parse(read("brave-query-filter.json")),
    ...JSON.parse(read("brave-clean-urls.json")),
  ],
  debounce: JSON.parse(read("brave-debounce.json")),
};

interface FakeLink {
  href: string;
}

/** Installs the cleaner in a fake page and returns a function that "follows" a link. */
function page(options: { top?: boolean; rules?: unknown } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const win: Record<string, unknown> = {
    URL,
    atob,
    decodeURIComponent,
    __openmediaLinkRules: options.rules ?? RULES,
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      listeners.set(type, handler),
  };
  win.window = win;
  win.top = options.top === false ? {} : win;
  vm.runInContext(SOURCE, vm.createContext(win));

  return {
    win,
    listeners,
    follow(href: string, type = "click"): string {
      const link: FakeLink = { href };
      const target = {
        closest: (selector: string) => (selector.includes("a[href]") ? link : null),
      };
      listeners.get(type)?.({ target });
      return link.href;
    },
  };
}

describe("openmedia-link-cleaner", () => {
  it("removes the tracking parameters Brave lists everywhere and keeps the rest in order", () => {
    const { follow } = page();
    expect(
      follow("https://shop.example.com/item?id=4&fbclid=abc&color=red&gclid=xyz#reviews"),
    ).toBe("https://shop.example.com/item?id=4&color=red#reviews");
  });

  it("leaves a link with nothing to clean exactly as it was", () => {
    const { follow } = page();
    for (const href of [
      "https://example.com",
      "https://example.com/a?b=c",
      "mailto:someone@example.com?fbclid=1",
      "javascript:void(0)",
    ]) {
      expect(follow(href)).toBe(href);
    }
  });

  it("applies site-specific parameters only on the sites that list them", () => {
    const { follow } = page();
    expect(follow("https://www.facebook.com/photo/?fbid=7&set=a.7&source=11")).toBe(
      "https://www.facebook.com/photo/?fbid=7",
    );
    expect(follow("https://example.com/photo/?fbid=7&set=a.7&source=11")).toBe(
      "https://example.com/photo/?fbid=7&set=a.7&source=11",
    );
  });

  it("matches a parameter by its decoded name too", () => {
    const { follow } = page();
    expect(follow("https://www.facebook.com/x?__cft__%5B0%5D=1&id=2")).toBe(
      "https://www.facebook.com/x?id=2",
    );
  });

  it("replaces a redirect-tracker link with its destination, then cleans that", () => {
    const { follow } = page();
    const destination = "https://store.example.net/p/1?fbclid=zz&size=m";
    expect(follow(`https://r.bttn.io/go?btn_url=${encodeURIComponent(destination)}`)).toBe(
      "https://store.example.net/p/1?size=m",
    );
  });

  it("decodes a base64 destination, URL-safe or not", () => {
    const { follow } = page();
    const destination = "https://store.example.net/p/1?q=a~b";
    const encoded = Buffer.from(destination).toString("base64url");
    expect(follow(`https://pvn.mediamarkt.de/trck/eclick/x?url64fb=${encoded}`)).toBe(destination);
  });

  it("takes the destination from the path when the rule says so", () => {
    const { follow } = page();
    expect(follow("https://click.redditmail.com/CL0/https:%2F%2Fexample.com%2Fpage/1/abc")).toBe(
      "https://example.com/page",
    );
  });

  it("follows a chain of trackers but stops after three", () => {
    const { follow } = page();
    const wrap = (inner: string) => `https://r.bttn.io/go?btn_url=${encodeURIComponent(inner)}`;
    const end = "https://example.com/end";
    expect(follow(wrap(wrap(end)))).toBe(end);
    expect(follow(wrap(wrap(wrap(wrap(end))))).startsWith("https://r.bttn.io/")).toBe(true);
  });

  it("ignores a destination that is not a web address", () => {
    const { follow } = page();
    const href = `https://r.bttn.io/go?btn_url=${encodeURIComponent("javascript:alert(1)")}`;
    expect(follow(href)).toBe(href);
  });

  it("does not apply rules Brave ties to a user preference, such as leaving AMP pages", () => {
    const { follow } = page();
    const href = "https://www-example-com.cdn.ampproject.org/c/s/www.example.com/story";
    expect(follow(href)).toBe(href);
  });

  it("acts on an auxiliary click as well and ignores clicks away from links", () => {
    const { follow, listeners } = page();
    expect(follow("https://example.com/?fbclid=1", "auxclick")).toBe("https://example.com/");
    const target = { closest: () => null };
    expect(() => listeners.get("click")?.({ target })).not.toThrow();
    expect(() => listeners.get("click")?.({ target: null })).not.toThrow();
  });

  it("listens in the capture phase so the page's own handlers see the clean link", () => {
    const calls: unknown[][] = [];
    const win: Record<string, unknown> = {
      URL,
      atob,
      decodeURIComponent,
      __openmediaLinkRules: RULES,
      addEventListener: (...args: unknown[]) => calls.push(args),
    };
    win.window = win;
    win.top = win;
    vm.runInContext(SOURCE, vm.createContext(win));
    expect(calls.map(([type, , capture]) => [type, capture])).toEqual([
      ["click", true],
      ["auxclick", true],
    ]);
  });

  it("does nothing in a subframe, and removes its data from the page's reach", () => {
    const { listeners, win } = page({ top: false });
    expect(listeners.size).toBe(0);
    expect(win.__openmediaLinkRules).toBeUndefined();
  });

  it("removes its data from the page's reach", () => {
    expect(page().win.__openmediaLinkRules).toBeUndefined();
  });

  it("survives a pattern or regular expression it cannot compile", () => {
    const { follow } = page({
      rules: {
        strip: [
          { include: ["not a pattern", "*://*/*"], exclude: [], params: ["x"] },
          { include: ["*://[/*"], exclude: [], params: ["y"] },
        ],
        debounce: [
          {
            include: ["*://*/*"],
            exclude: [],
            action: "regex-path",
            param: "([",
          },
        ],
      },
    });
    expect(follow("https://example.com/a?x=1&z=2")).toBe("https://example.com/a?z=2");
  });
});

describe("the bundled link-cleaning data", () => {
  it("has include patterns the cleaner can compile", () => {
    const { follow } = page();
    // A rule whose every pattern failed to compile would silently do nothing; each one is
    // exercised by turning its first include pattern into an address.
    const address = (pattern: string) =>
      pattern.replace("*://*.", "https://www.").replace("*://", "https://").replace(/\*/g, "x");
    for (const rule of RULES.strip) {
      const probe = `${address(rule.include[0])}${rule.include[0].includes("?") ? "&" : "?"}${rule.params[0]}=1&keep=1`;
      if (rule.exclude.length > 0) continue;
      const cleaned = follow(probe);
      expect(cleaned, `${rule.include[0]} never matches`).not.toBe(probe);
    }
  });
});
