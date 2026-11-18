import { describe, expect, it } from "vitest";
import type { FoundMedia } from "../../shared/ipc";
import { compilePattern, countByKind, filterMedia } from "./sniffFilter";

const found = (url: string, kind: FoundMedia["kind"], label = ""): FoundMedia => ({
  url,
  kind,
  label,
  width: 0,
  height: 0,
});

const ITEMS = [
  found("https://a.example/cat.jpg", "image", "A cat"),
  found("https://a.example/dog.png", "image"),
  found("https://a.example/clip.mp4", "video"),
  found("https://a.example/report.pdf", "document", "Q3 report"),
];

describe("filterMedia", () => {
  it("filters by kind", () => {
    expect(filterMedia(ITEMS, "image", "")).toHaveLength(2);
    expect(filterMedia(ITEMS, "all", "")).toHaveLength(4);
    expect(filterMedia(ITEMS, "audio", "")).toHaveLength(0);
  });

  it("filters by an expression over the address and the label, ignoring case", () => {
    expect(filterMedia(ITEMS, "all", "\\.(png|mp4)$").map((i) => i.url)).toEqual([
      "https://a.example/dog.png",
      "https://a.example/clip.mp4",
    ]);
    expect(filterMedia(ITEMS, "all", "q3")).toHaveLength(1);
  });

  it("combines kind and expression", () => {
    expect(filterMedia(ITEMS, "image", "cat")).toHaveLength(1);
  });

  it("filters nothing while the expression is invalid", () => {
    expect(compilePattern("(")).toBe("invalid");
    expect(filterMedia(ITEMS, "all", "(")).toHaveLength(4);
  });
});

describe("countByKind", () => {
  it("counts each kind and the total", () => {
    expect(countByKind(ITEMS)).toMatchObject({ all: 4, image: 2, video: 1, document: 1, audio: 0 });
  });
});
