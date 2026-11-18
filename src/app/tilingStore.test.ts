import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";
import { newSession } from "../features/web/sessions";
import { leaves, pane, type Layout } from "../features/tiling/layout";
import type { Tiles } from "../shared/ipc";

const S = (id: string, url = `https://${id}.example/`) => newSession(id, "typed", url, Date.now());
const row = (first: Layout, second: Layout): Layout => ({
  kind: "split",
  direction: "row",
  ratio: 0.5,
  first,
  second,
});

function setup(ids: string[], layout: Layout | null, activeId: string | null = ids[0]) {
  invoke.mockReset().mockResolvedValue(undefined);
  useApp.setState({
    sessions: ids.map((id) => S(id)),
    activeId,
    blankTab: false,
    layout,
    tileIntent: null,
    action: null,
    sheet: "none",
    sites: [],
    state: null,
    incognito: { active: false, favorites: [], folders: [], busy: false },
  });
}

const layoutIds = () => {
  const { layout } = useApp.getState();
  return layout ? leaves(layout) : null;
};

describe("windows in the store", () => {
  beforeEach(() => setup(["a", "b", "c"], null));

  it("drops an open page beside the page in front, which becomes a layout of two", () => {
    useApp.getState().dropPage({ kind: "session", id: "b" }, "a", "right");
    expect(layoutIds()).toEqual(["a", "b"]);
    expect(useApp.getState().activeId).toBe("b");
    expect(useApp.getState().tileIntent).toBeNull();
    expect(useApp.getState().action).toMatchObject({ type: "activate", id: "b" });
  });

  it("opens a dropped favorite as a new session in a new window", () => {
    useApp
      .getState()
      .dropPage({ kind: "favorite", favorite: { url: "https://new.example/" } }, "a", "bottom");
    const { sessions, activeId, action } = useApp.getState();
    expect(sessions).toHaveLength(4);
    expect(layoutIds()).toEqual(["a", activeId]);
    expect(action).toMatchObject({
      type: "open",
      url: "https://new.example/",
      previousLayout: null,
    });
  });

  it("a drop on the middle takes the window's place and leaves the old page open", () => {
    setup(["a", "b", "c"], row(pane("a"), pane("b")));
    useApp.getState().dropPage({ kind: "session", id: "c" }, "b", "center");
    expect(layoutIds()).toEqual(["a", "c"]);
    expect(useApp.getState().sessions.map((s) => s.id)).toContain("b");
  });

  it("a drop on an empty page starts over with that page alone", () => {
    setup(["a", "b", "c"], row(pane("a"), pane("b")));
    useApp.setState({ blankTab: true });
    useApp.getState().dropPage({ kind: "session", id: "c" }, null, "center");
    expect(useApp.getState().layout).toBeNull();
    expect(useApp.getState().activeId).toBe("c");
    expect(useApp.getState().blankTab).toBe(false);
  });

  it("a page opened without a drop takes the window in front, and a page already shown just comes to the front", () => {
    setup(["a", "b", "c"], row(pane("a"), pane("b")), "b");
    useApp.getState().openSession("c");
    expect(layoutIds()).toEqual(["a", "c"]);
    useApp.getState().openSession("a");
    expect(layoutIds()).toEqual(["a", "c"]);
    expect(useApp.getState().activeId).toBe("a");
  });

  it("closing a window gives its room to the neighbour, and the last two leave no layout", () => {
    setup(["a", "b", "c"], row(pane("a"), row(pane("b"), pane("c"))), "b");
    useApp.getState().closeSession("b");
    expect(layoutIds()).toEqual(["a", "c"]);
    expect(useApp.getState().activeId).toBe("c");
    useApp.getState().closeSession("c");
    expect(useApp.getState().layout).toBeNull();
    expect(useApp.getState().activeId).toBe("a");
  });

  it("sessions the native side dropped leave the layout too", () => {
    setup(["a", "b"], row(pane("a"), pane("b")), "a");
    useApp.getState().forgetSessions(["a"]);
    expect(useApp.getState().layout).toBeNull();
    expect(useApp.getState().activeId).toBe("b");
    expect(useApp.getState().action).toMatchObject({ type: "activate", id: "b" });
  });

  it("the sweep never closes a window on screen", () => {
    setup(["a", "b", "c", "d", "e", "f", "g"], row(pane("a"), pane("b")), "a");
    useApp.getState().trimSessions("memory");
    const open = useApp.getState().sessions.map((s) => s.id);
    expect(open).toContain("a");
    expect(open).toContain("b");
    expect(open).not.toContain("g");
  });

  it("a page that fails to open gives its window back to the page it had replaced", () => {
    setup(["a", "b"], row(pane("a"), pane("b")), "b");
    useApp.getState().openSession("a");
    useApp.setState({ layout: row(pane("a"), pane("b")), activeId: "b" });
    useApp.getState().openAddress("https://typed.example/");
    const opened = useApp.getState().action;
    expect(opened?.type).toBe("open");
    const id = opened?.type === "open" ? opened.id : "";
    useApp.getState().sessionOpenFailed(id);
    expect(layoutIds()).toEqual(["a", "b"]);
    expect(useApp.getState().activeId).toBe("b");
  });

  it("focus moves, swaps and resizes follow the arrangement", () => {
    setup(["a", "b", "c"], row(pane("a"), row(pane("b"), pane("c"))), "a");
    useApp.getState().focusWindow("right");
    expect(useApp.getState().activeId).toBe("b");
    useApp.getState().focusNextWindow(1);
    expect(useApp.getState().activeId).toBe("c");
    useApp.getState().focusNextWindow(1);
    expect(useApp.getState().activeId).toBe("a");
    useApp.getState().swapWindow("right");
    expect(layoutIds()).toEqual(["b", "a", "c"]);
    useApp.getState().resizeWindow(0.1);
    const next = useApp.getState().layout;
    expect(next?.kind === "split" && next.second.kind === "split" && next.second.ratio).toBeCloseTo(
      0.6,
    );
    useApp.getState().keepOnlyWindow();
    expect(useApp.getState().layout).toBeNull();
    expect(useApp.getState().sessions).toHaveLength(3);
  });
});

describe("folders as layouts", () => {
  const favorite = (name: string, folder = "Desk") => ({
    id: name,
    name,
    url: `https://${name}.example/`,
    notify: true,
    folder,
  });
  const withFolder = (layout?: Tiles) =>
    useApp.setState({
      state: {
        favorites: [favorite("a"), favorite("new"), favorite("other", "Else")],
        folders: [{ name: "Desk", ...(layout ? { layout } : {}) }],
      } as never,
    });

  beforeEach(() => setup(["a"], null));

  it("opens a folder in its default layout, reusing live pages and opening the rest", () => {
    withFolder();
    useApp.getState().openFolder("desk");
    const { sessions, layout, activeId, action } = useApp.getState();
    expect(sessions).toHaveLength(2);
    expect(layout && leaves(layout)).toHaveLength(2);
    expect(activeId).toBe("a");
    expect(action).toMatchObject({ type: "openAll", focus: "a" });
    expect(action?.type === "openAll" && action.opens.map((o) => o.url)).toEqual([
      "https://new.example/",
    ]);
  });

  it("opens a folder in the layout it was saved in", () => {
    withFolder({
      kind: "split",
      direction: "column",
      ratio: 0.3,
      first: { kind: "pane", url: "https://new.example/" },
      second: { kind: "pane", url: "https://a.example/" },
    });
    useApp.getState().openFolder("Desk");
    const { layout, sessions } = useApp.getState();
    expect(layout).toMatchObject({ kind: "split", direction: "column", ratio: 0.3 });
    const order = layout ? leaves(layout) : [];
    expect(sessions.find((s) => s.id === order[1])?.openedUrl).toBe("https://a.example/");
  });

  it("dropping a folder on the page starts over with its windows", () => {
    setup(["a", "b", "c"], row(pane("b"), pane("c")), "b");
    withFolder();
    useApp.getState().dropPage({ kind: "folder", name: "Desk" }, "b", "left");
    const { layout, activeId } = useApp.getState();
    expect(layout && leaves(layout)).toHaveLength(2);
    expect(layout && leaves(layout)).toContain("a");
    expect(activeId).toBe("a");
  });

  it("a folder of one favorite just opens it", () => {
    useApp.setState({
      state: { favorites: [favorite("solo", "One")], folders: [] } as never,
    });
    useApp.getState().openFolder("One");
    expect(useApp.getState().layout).toBeNull();
    expect(useApp.getState().sessions).toHaveLength(2);
  });

  it("saves the windows as a folder, keeping their layout", async () => {
    setup(["a", "b"], row(pane("a"), pane("b")), "a");
    useApp.setState({ state: { favorites: [], folders: [] } as never });
    invoke.mockImplementation((_command: string, args: Record<string, unknown>) =>
      Promise.resolve(args.favorites ?? args.folders),
    );
    await expect(useApp.getState().saveWindowsToFolder("Pair")).resolves.toBe(true);
    const saved = invoke.mock.calls.find(([command]) => command === "set_folders")?.[1] as {
      folders: { name: string; layout: unknown }[];
    };
    expect(saved.folders[0]).toMatchObject({
      name: "Pair",
      layout: {
        kind: "split",
        direction: "row",
        first: { kind: "pane", url: "https://a.example/" },
        second: { kind: "pane", url: "https://b.example/" },
      },
    });
  });

  it("saves nothing when there is no layout, or while incognito", async () => {
    await expect(useApp.getState().saveWindowsToFolder("Solo")).resolves.toBe(false);
    setup(["a", "b"], row(pane("a"), pane("b")), "a");
    useApp.setState({ incognito: { active: true, favorites: [], folders: [], busy: false } });
    await expect(useApp.getState().saveWindowsToFolder("Hidden")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("changing the arrangement", () => {
  it("flips the split of the window in front and arranges all windows again", () => {
    setup(["a", "b", "c"], row(pane("a"), row(pane("b"), pane("c"))), "c");
    useApp.getState().flipWindow();
    const flipped = useApp.getState().layout;
    expect(
      flipped?.kind === "split" && flipped.second.kind === "split" && flipped.second.direction,
    ).toBe("column");
    useApp.getState().arrangeWindows("column");
    const column = useApp.getState().layout;
    expect(column?.kind === "split" && column.direction).toBe("column");
    expect(layoutIds()).toEqual(["a", "b", "c"]);
  });
});
