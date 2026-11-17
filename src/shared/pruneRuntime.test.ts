import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("../../src-tauri/src/prune_runtime.js", import.meta.url),
  "utf8",
);
const KEY = Symbol.for("openmedia.prune");
const ORIGIN = "https://site.example";
const MAX_BYTES = 2 * 1024 * 1024;

type Step = string | number;
interface Removal {
  steps: Step[];
  when: { key: string; equals: string | number | boolean } | null;
}
interface Rule {
  urls: string[];
  remove: Removal[];
}

// What `prune.rs` builds for `urls: ["/api/feed"]` and `remove: [{ path: "data.items[*]" }]`.
const REELS: Rule = {
  urls: ["^/api/feed$"],
  remove: [{ steps: ["data", "items", "*"], when: { key: "media_type", equals: 2 } }],
};

const FEED = {
  data: {
    items: [
      { id: 1, media_type: 1 },
      { id: 2, media_type: 2 },
      { id: 3, media_type: 1 },
      { id: 4, media_type: 2 },
    ],
  },
};

interface Call {
  input: unknown;
  init: unknown;
}

interface FakeXhr {
  readyState: number;
  responseType: string;
  responseURL: string;
  responseText: string;
  type: string;
  response: unknown;
  open: (method: string, url: string) => void;
  getResponseHeader: (name: string) => string | null;
}

/** A page: a `window` with stub fetch/XHR in a fresh realm and the runtime function to install. */
function page(respond: (input: unknown) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const win: Record<string | symbol, unknown> = {
    URL,
    Response,
    Headers,
    TextDecoder,
    Uint8Array,
    location: { href: `${ORIGIN}/feed`, origin: ORIGIN },
    fetch(input: unknown, init?: unknown) {
      calls.push({ input, init });
      return Promise.resolve(respond(input));
    },
  };
  class Xhr {
    readyState = 0;
    responseType = "";
    responseURL = "";
    body = "";
    type = "application/json";
    open(_method: string, url: string) {
      this.responseURL = url;
    }
    getResponseHeader(name: string) {
      return name.toLowerCase() === "content-type" ? this.type : null;
    }
    get responseText() {
      return this.body;
    }
    get response() {
      return this.responseType === "json" ? JSON.parse(this.body) : this.body;
    }
  }
  win.XMLHttpRequest = Xhr;
  win.window = win;
  const context = vm.createContext(win);
  const runtime = vm.runInContext(`(${SOURCE})`, context) as (rules: Rule[]) => void;
  return {
    win,
    xhrPrototype: Xhr.prototype,
    calls,
    install: (rules: Rule[] = [REELS]) => runtime(rules),
    fetch: (input: unknown, init?: unknown) =>
      (win.fetch as (input: unknown, init?: unknown) => Promise<Response>)(input, init),
    xhr(url: string, body: string, options: Partial<FakeXhr> = {}) {
      const request = new (win.XMLHttpRequest as new () => FakeXhr)();
      request.open("GET", url);
      Object.assign(request, { readyState: 4, body, responseURL: url, ...options });
      return request;
    },
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });

const ids = (feed: { data: { items: { id: number }[] } }) => feed.data.items.map((item) => item.id);

describe("prune runtime: fetch", () => {
  it("removes the items a rule reaches from a matching same-origin JSON response", async () => {
    const { install, fetch } = page(() => json(FEED));
    install();
    const response = await fetch("/api/feed");
    expect(ids(await response.json())).toEqual([1, 3]);
  });

  it("also matches an absolute URL on the page's own origin and a Request object", async () => {
    const { install, fetch } = page(() => json(FEED));
    install();
    expect(ids(await (await fetch(`${ORIGIN}/api/feed`)).json())).toEqual([1, 3]);
    expect(ids(await (await fetch({ url: "/api/feed" })).json())).toEqual([1, 3]);
  });

  it("keeps the status and headers and gives the page the response's own URL", async () => {
    const { install, fetch } = page(() => {
      const response = json(FEED, { "x-keep": "yes", "content-length": "999" });
      Object.defineProperty(response, "url", { value: `${ORIGIN}/api/feed` });
      return response;
    });
    install();
    const response = await fetch("/api/feed");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-keep")).toBe("yes");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.url).toBe(`${ORIGIN}/api/feed`);
  });

  it("leaves a request whose URL no rule matches exactly as it was", async () => {
    let original: Response | undefined;
    const { install, fetch } = page(() => (original = json(FEED)));
    install();
    expect(await fetch("/api/other")).toBe(original);
    expect(await fetch("/api/feed/extra")).toBe(original);
  });

  it("never reaches a response that is not JSON", async () => {
    let original: Response | undefined;
    const { install, fetch } = page(
      () =>
        (original = new Response("<html>{}</html>", { headers: { "content-type": "text/html" } })),
    );
    install();
    expect(await fetch("/api/feed")).toBe(original);
  });

  it("returns the original response when the JSON is malformed or not an object", async () => {
    for (const body of ['{"data": {"items": [', "plain words", "42", "null"]) {
      let original: Response | undefined;
      const { install, fetch } = page(() => (original = json(body)));
      install();
      const response = await fetch("/api/feed");
      expect(response).toBe(original);
      expect(await response.text()).toBe(body);
    }
  });

  it("returns the original response when the shape does not match or nothing is removed", async () => {
    for (const body of [
      { other: [] },
      { data: { items: "nope" } },
      { data: { items: [{ id: 1 }] } },
    ]) {
      let original: Response | undefined;
      const { install, fetch } = page(() => (original = json(body)));
      install();
      expect(await fetch("/api/feed")).toBe(original);
    }
  });

  it("leaves a response that is not ok, and an error status, alone", async () => {
    let original: Response | undefined;
    const { install, fetch } = page(
      () =>
        (original = new Response(JSON.stringify(FEED), {
          status: 500,
          headers: { "content-type": "application/json" },
        })),
    );
    install();
    expect(await fetch("/api/feed")).toBe(original);
  });

  it("leaves another origin alone, including a redirect that ends there", async () => {
    let original: Response | undefined;
    const { install, fetch } = page(() => (original = json(FEED)));
    install();
    expect(await fetch("https://other.example/api/feed")).toBe(original);
    expect(await fetch("//other.example/api/feed")).toBe(original);
    expect(await fetch("http://site.example/api/feed")).toBe(original);

    const redirected = page(() => {
      const response = json(FEED);
      Object.defineProperty(response, "url", { value: "https://other.example/api/feed" });
      return (original = response);
    });
    redirected.install();
    expect(await redirected.fetch("/api/feed")).toBe(original);
  });

  it("starts and changes no request: the page's own call goes through with its arguments", async () => {
    const { install, fetch, calls } = page(() => json(FEED));
    install();
    const init = { method: "POST", body: "secret" };
    await fetch("/api/feed", init);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ input: "/api/feed", init });
    expect(calls[0]?.init).toBe(init);
  });

  it("stops pruning when the rules are replaced by none, and resumes when they come back", async () => {
    const { install, fetch } = page(() => json(FEED));
    install();
    expect(ids(await (await fetch("/api/feed")).json())).toEqual([1, 3]);
    install([]);
    expect(ids(await (await fetch("/api/feed")).json())).toEqual([1, 2, 3, 4]);
    install();
    expect(ids(await (await fetch("/api/feed")).json())).toEqual([1, 3]);
  });

  it("stops pruning a request already in flight when the rules are replaced before it ends", async () => {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((done) => (resolve = done));
    const { install, fetch } = page(() => promise);
    install();
    const pending = fetch("/api/feed");
    install([]);
    resolve(json(FEED));
    expect(ids(await (await pending).json())).toEqual([1, 2, 3, 4]);
  });

  it("wraps fetch and XMLHttpRequest once however often it is installed", async () => {
    const { win, install, fetch, calls, xhrPrototype } = page(() => json(FEED));
    install();
    const wrapped = win.fetch;
    const open = xhrPrototype.open;
    install();
    install([REELS, REELS]);
    expect(win.fetch).toBe(wrapped);
    expect(xhrPrototype.open).toBe(open);
    expect(ids(await (await fetch("/api/feed")).json())).toEqual([1, 3]);
    expect(calls).toHaveLength(1);
  });

  it("leaves a body larger than the cap alone, by its length and by counting a stream", async () => {
    const big = JSON.stringify({
      data: { items: [{ id: 1, media_type: 2, pad: "x".repeat(MAX_BYTES) }] },
    });
    const declared = page(() => json(big, { "content-length": String(big.length) }));
    declared.install();
    const first = await declared.fetch("/api/feed");
    expect(await first.text()).toBe(big);

    const chunk = new TextEncoder().encode(big.slice(0, 1024 * 1024));
    const rest = new TextEncoder().encode(big.slice(1024 * 1024));
    let original: Response | undefined;
    const streamed = page(
      () =>
        (original = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(rest);
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        )),
    );
    streamed.install();
    const second = await streamed.fetch("/api/feed");
    expect(second).toBe(original);
    expect((await second.text()).length).toBe(big.length);
  });

  it("handles a body just under the cap", async () => {
    const body = {
      data: {
        items: [
          { id: 1, media_type: 2 },
          { id: 2, media_type: 1, pad: "x".repeat(MAX_BYTES - 200) },
        ],
      },
    };
    const { install, fetch } = page(() => json(body));
    install();
    expect(ids(await (await fetch("/api/feed")).json())).toEqual([2]);
  });

  it("applies a rule without a condition to every item, and a condition only to equal values", async () => {
    const all: Rule = {
      urls: ["^/api/feed$"],
      remove: [{ steps: ["data", "items", "*"], when: null }],
    };
    const some = page(() => json(FEED));
    some.install([
      {
        urls: ["^/api/feed$"],
        remove: [{ steps: ["data", "items", "*"], when: { key: "media_type", equals: 1 } }],
      },
    ]);
    expect(ids(await (await some.fetch("/api/feed")).json())).toEqual([2, 4]);
    const everything = page(() => json(FEED));
    everything.install([all]);
    expect((await (await everything.fetch("/api/feed")).json()).data.items).toEqual([]);

    const strict = page(() =>
      json({ data: { items: [{ media_type: "2" }, { media_type: 2 }, 7, null] } }),
    );
    strict.install();
    const kept = (await (await strict.fetch("/api/feed")).json()).data.items;
    expect(kept).toEqual([{ media_type: "2" }, 7, null]);
  });

  it("follows nested paths, indexes, keys and several removals", async () => {
    const body = {
      edges: [
        { node: { kind: "post", items: [{ ad: true }, { ad: false }], ads: [1] } },
        { node: { kind: "reel", items: [{ ad: true }] } },
        { node: null },
      ],
      suggested: { users: [1, 2] },
      list: [10, 20, 30],
    };
    const { install, fetch } = page(() => json(body));
    install([
      {
        urls: ["^/api/.*$"],
        remove: [
          { steps: ["edges", "*", "node", "items", "*"], when: { key: "ad", equals: true } },
          { steps: ["edges", "*", "node", "ads"], when: null },
          { steps: ["suggested"], when: null },
          { steps: ["list", 1], when: null },
          { steps: ["edges", 5], when: null },
          { steps: ["edges", 2, "node", "missing"], when: null },
        ],
      },
    ]);
    const result = await (await fetch("/api/anything")).json();
    expect(result).toEqual({
      edges: [
        { node: { kind: "post", items: [{ ad: false }] } },
        { node: { kind: "reel", items: [] } },
        { node: null },
      ],
      list: [10, 30],
    });
  });

  it("handles a response that is a top-level array", async () => {
    const { install, fetch } = page(() => json([{ t: "a" }, { t: "b" }, { t: "a" }]));
    install([{ urls: ["^/list$"], remove: [{ steps: ["*"], when: { key: "t", equals: "a" } }] }]);
    expect(await (await fetch("/list")).json()).toEqual([{ t: "b" }]);
  });

  it("never walks into a prototype key", async () => {
    const { install, fetch } = page(() => json('{"__proto__":{"x":1},"a":1}'));
    install([{ urls: ["^/x$"], remove: [{ steps: ["a"], when: null }] }]);
    const result = await (await fetch("/x")).json();
    expect(Object.keys(result)).toEqual(["__proto__"]);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "x")).toBe(false);
  });

  it("switches itself off after repeated unexpected failures and never breaks the response", async () => {
    const throwing = {
      get ok(): boolean {
        throw new Error("boom");
      },
    } as unknown as Response;
    const { win, install, fetch } = page(() => throwing);
    install();
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(await fetch("/api/feed")).toBe(throwing);
    }
    const state = win[KEY] as { rules: unknown[] };
    expect(state.rules).toEqual([]);
  });

  it("ignores a rule whose pattern cannot compile", async () => {
    const { install, fetch } = page(() => json(FEED));
    install([{ urls: ["("], remove: REELS.remove }, REELS]);
    expect(ids(await (await fetch("/api/feed")).json())).toEqual([1, 3]);
  });
});

describe("prune runtime: XMLHttpRequest", () => {
  const body = JSON.stringify(FEED);

  it("prunes the finished response text of a matching same-origin request", () => {
    const { install, xhr } = page(() => json(FEED));
    install();
    const request = xhr("/api/feed", body);
    expect(ids(JSON.parse(request.responseText))).toEqual([1, 3]);
    expect(ids(JSON.parse(request.response as string))).toEqual([1, 3]);
  });

  it("prunes the object of a json response type", () => {
    const { install, xhr } = page(() => json(FEED));
    install();
    const request = xhr("/api/feed", body, { responseType: "json" });
    expect(ids(request.response as typeof FEED)).toEqual([1, 3]);
    expect(ids(request.response as typeof FEED)).toEqual([1, 3]);
  });

  it("leaves other URLs, other origins, non-JSON and malformed bodies alone", () => {
    const { install, xhr } = page(() => json(FEED));
    install();
    expect(xhr("/api/other", body).responseText).toBe(body);
    expect(xhr("https://other.example/api/feed", body).responseText).toBe(body);
    expect(xhr("/api/feed", "<html></html>", { type: "text/html" }).responseText).toBe(
      "<html></html>",
    );
    expect(xhr("/api/feed", "{ not json").responseText).toBe("{ not json");
    expect(
      xhr("/api/feed", body, { responseURL: "https://other.example/api/feed" }).responseText,
    ).toBe(body);
  });

  it("waits for the whole body and leaves other response types alone", () => {
    const { install, xhr } = page(() => json(FEED));
    install();
    expect(xhr("/api/feed", body, { readyState: 3 }).responseText).toBe(body);
    expect(xhr("/api/feed", body, { responseType: "arraybuffer" }).response).toBe(body);
  });

  it("leaves a body larger than the cap alone", () => {
    const big = JSON.stringify({
      data: { items: [{ id: 1, media_type: 2, pad: "x".repeat(MAX_BYTES) }] },
    });
    const { install, xhr } = page(() => json(FEED));
    install();
    expect(xhr("/api/feed", big).responseText).toBe(big);
  });

  it("stops pruning when the rules are replaced by none", () => {
    const { install, xhr } = page(() => json(FEED));
    install();
    install([]);
    expect(xhr("/api/feed", body).responseText).toBe(body);
  });
});
