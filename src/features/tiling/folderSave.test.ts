import { describe, expect, it } from "vitest";
import { windowsToFolder } from "./folderSave";
import { pane, type Layout } from "./layout";

const windows: Layout = {
  kind: "split",
  direction: "row",
  ratio: 0.4,
  first: pane("a"),
  second: pane("b"),
};
const pages: Record<string, string> = {
  a: "https://a.example/",
  b: "https://b.example/feed",
};
const openedUrl = (id: string) => pages[id] ?? null;

describe("windowsToFolder", () => {
  it("makes a favorite of each page that is not one yet, filed in the folder", () => {
    const saved = windowsToFolder("Desk", windows, openedUrl, [], []);
    expect(saved?.favorites).toEqual([
      { name: "a.example", url: "https://a.example/", landing: null, folder: "Desk" },
      {
        name: "b.example",
        url: "https://b.example/",
        landing: "https://b.example/feed",
        folder: "Desk",
      },
    ]);
    expect(saved?.folders).toEqual([
      {
        name: "Desk",
        layout: {
          kind: "split",
          direction: "row",
          ratio: 0.4,
          first: { kind: "pane", url: "https://a.example/" },
          second: { kind: "pane", url: "https://b.example/" },
        },
      },
    ]);
  });

  it("reuses a favorite already in the folder and keeps the folder's icon", () => {
    const favorites = [
      { name: "A", url: "https://a.example/", folder: "desk" },
      { name: "Other", url: "https://b.example/", folder: "Elsewhere" },
    ];
    const saved = windowsToFolder("Desk", windows, openedUrl, favorites, [
      { name: "desk", icon: "💼" },
    ]);
    expect(saved?.favorites).toHaveLength(3);
    expect(saved?.folders[0]).toMatchObject({ name: "desk", icon: "💼" });
    expect(saved?.folders).toHaveLength(1);
  });

  it("refuses a blank name and a window with no address", () => {
    expect(windowsToFolder("  ", windows, openedUrl, [], [])).toBeNull();
    expect(windowsToFolder("Desk", windows, () => null, [], [])).toBeNull();
  });
});
