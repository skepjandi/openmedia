import { describe, expect, it } from "vitest";
import type { Download } from "../../shared/ipc";
import { fraction, justEnded, newestFirst, upsert } from "./list";

const download = (changes: Partial<Download>): Download => ({
  id: "a",
  url: "https://example.com/a.bin",
  fileName: "a.bin",
  path: null,
  kind: "other",
  status: "downloading",
  received: 0,
  total: null,
  speed: 0,
  resumable: true,
  error: null,
  site: "example.com",
  addedAt: 1,
  finishedAt: null,
  private: false,
  ...changes,
});

describe("upsert", () => {
  it("replaces a listed download and appends a new one", () => {
    const list = [download({ id: "a" }), download({ id: "b" })];
    const replaced = upsert(list, download({ id: "a", received: 5 }));
    expect(replaced.map((d) => [d.id, d.received])).toEqual([
      ["a", 5],
      ["b", 0],
    ]);
    expect(upsert(list, download({ id: "c" })).map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(list[0].received).toBe(0);
  });
});

describe("justEnded", () => {
  it("is true only on the update that ends a download we saw in progress", () => {
    const running = [download({ status: "downloading" })];
    expect(justEnded(running, download({ status: "done" }))).toBe(true);
    expect(justEnded(running, download({ status: "failed" }))).toBe(true);
    expect(justEnded(running, download({ status: "paused" }))).toBe(false);
    expect(justEnded(running, download({ status: "cancelled" }))).toBe(false);
  });

  it("is false for a finished download that is updated again, or one never listed", () => {
    expect(justEnded([download({ status: "done" })], download({ status: "done" }))).toBe(false);
    expect(justEnded([], download({ status: "done" }))).toBe(false);
  });
});

describe("fraction and ordering", () => {
  it("reports progress, with unknown sizes as null and finished ones as full", () => {
    expect(fraction(download({ received: 25, total: 100 }))).toBe(0.25);
    expect(fraction(download({ received: 25, total: null }))).toBeNull();
    expect(fraction(download({ status: "done", total: null }))).toBe(1);
    expect(fraction(download({ received: 300, total: 100 }))).toBe(1);
  });

  it("lists the newest first without changing the input", () => {
    const list = [download({ id: "old", addedAt: 1 }), download({ id: "new", addedAt: 9 })];
    expect(newestFirst(list).map((d) => d.id)).toEqual(["new", "old"]);
    expect(list[0].id).toBe("old");
  });
});
