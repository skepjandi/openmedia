import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("../../../src-tauri/src/downloads/sniff.js", import.meta.url),
  "utf8",
);

interface Page {
  images?: Record<string, unknown>[];
  videos?: Record<string, unknown>[];
  anchors?: Record<string, unknown>[];
  styled?: string[];
  resources?: { name: string; initiatorType: string }[];
}

/** Runs the sniffer against a stand-in document: only the queries the script makes are answered. */
function sniff(page: Page, base = "https://site.example/dir/page.html") {
  const lists: Record<string, unknown[]> = {
    img: (page.images ?? []).map((image) => ({ getAttribute: () => null, ...image })),
    video: page.videos ?? [],
    "a[href]": page.anchors ?? [],
    '[style*="url("]': (page.styled ?? []).map((style) => ({
      getAttribute: () => style,
    })),
  };
  const document = {
    baseURI: base,
    title: "A page",
    querySelectorAll: (selector: string) => lists[selector] ?? [],
  };
  const context = vm.createContext({
    document,
    URL,
    location: { href: base },
    performance: { getEntriesByType: () => page.resources ?? [] },
  });
  return vm.runInContext(SOURCE, context) as {
    page: { url: string; title: string };
    items: { u: string; k: string; t: string; w: number; h: number }[];
  };
}

describe("the media sniffer script", () => {
  it("reports the page and resolves relative addresses against it", () => {
    const result = sniff({
      images: [{ src: "../pics/a.png", alt: "A", naturalWidth: 10, naturalHeight: 20 }],
    });
    expect(result.page).toEqual({ url: "https://site.example/dir/page.html", title: "A page" });
    expect(result.items).toEqual([
      { u: "https://site.example/pics/a.png", k: "image", t: "A", w: 10, h: 20 },
    ]);
  });

  it("prefers the largest srcset candidate and reads lazy-load attributes", () => {
    const result = sniff({
      images: [
        {
          srcset: "/s.jpg 1x, /l.jpg 2x",
          getAttribute: (name: string) => (name === "data-src" ? "/lazy.jpg" : null),
        },
      ],
    });
    expect(result.items.map((i) => i.u)).toEqual([
      "https://site.example/l.jpg",
      "https://site.example/lazy.jpg",
    ]);
  });

  it("collects links with their text, inline background images and requested resources", () => {
    const result = sniff({
      anchors: [{ href: "https://site.example/a.zip", textContent: "  Get \n it " }],
      styled: ["background: url('/bg.jpg') no-repeat"],
      resources: [{ name: "https://cdn.example/clip.mp4", initiatorType: "video" }],
    });
    expect(result.items).toEqual([
      { u: "https://site.example/bg.jpg", k: "image", t: "", w: 0, h: 0 },
      { u: "https://site.example/a.zip", k: "link", t: "Get it", w: 0, h: 0 },
      { u: "https://cdn.example/clip.mp4", k: "video", t: "", w: 0, h: 0 },
    ]);
  });

  it("drops non-web addresses and lists an address once per kind", () => {
    const result = sniff({
      images: [{ src: "data:image/png;base64,AAAA" }, { src: "/a.png" }, { src: "/a.png" }],
      anchors: [
        { href: "javascript:void(0)", textContent: "x" },
        { href: "mailto:a@b.c", textContent: "m" },
      ],
    });
    expect(result.items.map((i) => i.u)).toEqual(["https://site.example/a.png"]);
  });
});
