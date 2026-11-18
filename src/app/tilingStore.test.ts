import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";
import { newSession } from "../features/web/sessions";
import { leaves, pane, type Layout } from "../features/tiling/layout";
import type { Workspace } from "../shared/ipc";

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

describe("saved layouts", () => {
  const workspace: Workspace = {
    id: "w",
    name: "Desk",
    layout: {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      first: { kind: "pane", url: "https://a.example/" },
      second: { kind: "pane", url: "https://new.example/" },
    },
  };

  beforeEach(() => setup(["a"], null));

  it("opens a live page where there is one and a new session where not, and brings the layout up", () => {
    useApp.getState().openWorkspace(workspace);
    const { sessions, layout, activeId, action } = useApp.getState();
    expect(sessions).toHaveLength(2);
    expect(layout && leaves(layout)).toHaveLength(2);
    expect(activeId).toBe("a");
    expect(action).toMatchObject({ type: "openAll", focus: "a" });
    expect(action?.type === "openAll" && action.opens.map((o) => o.url)).toEqual([
      "https://new.example/",
    ]);
  });

  it("gives two windows on one address a session each", () => {
    const twice: Workspace = {
      ...workspace,
      layout: {
        ...(workspace.layout as Extract<Workspace["layout"], { kind: "split" }>),
        second: { kind: "pane", url: "https://a.example/" },
      },
    };
    useApp.getState().openWorkspace(twice);
    const ids = layoutIds() ?? [];
    expect(new Set(ids).size).toBe(2);
  });

  it("saves the windows with the address each was opened with", async () => {
    setup(["a", "b"], row(pane("a"), pane("b")), "a");
    useApp.setState({ state: { workspaces: [] } as never });
    invoke.mockImplementation((_command: string, args: { workspaces: unknown[] }) =>
      Promise.resolve(args.workspaces.map((entry, i) => ({ id: `id${i}`, ...(entry as object) }))),
    );
    await expect(useApp.getState().saveWorkspace("Pair")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_workspaces", {
      workspaces: [
        {
          name: "Pair",
          layout: {
            kind: "split",
            direction: "row",
            ratio: 0.5,
            first: { kind: "pane", url: "https://a.example/" },
            second: { kind: "pane", url: "https://b.example/" },
          },
        },
      ],
    });
  });

  it("saves nothing when there is no layout, or while incognito", async () => {
    await expect(useApp.getState().saveWorkspace("Solo")).resolves.toBe(false);
    setup(["a", "b"], row(pane("a"), pane("b")), "a");
    useApp.setState({ incognito: { active: true, favorites: [], folders: [], busy: false } });
    await expect(useApp.getState().saveWorkspace("Hidden")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
