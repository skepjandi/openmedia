import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";
import { applyState, newSession } from "../features/web/sessions";
import type { AppState, Bookmark } from "../shared/ipc";

const calls = (name: string) => invoke.mock.calls.filter((call) => call[0] === name);

const page = applyState(newSession("p", "typed", "https://news.example/", 1), {
  session: "p",
  scope: "news.example",
  url: "https://news.example/story/42",
  title: " A story ",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  playing: false,
  painted: true,
});

const withBookmark = (bookmark: Bookmark | null) =>
  ({ theme: "system", favorites: [], history: [], bookmark }) as unknown as AppState;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (name: string, args?: { url: string; title: string }) =>
    name === "set_bookmark" ? { url: args?.url, title: args?.title } : {},
  );
  useApp.setState({
    state: withBookmark(null),
    sessions: [page],
    activeId: "p",
    action: null,
    incognito: { active: false, favorites: [], folders: [], busy: false },
    error: null,
  });
});

describe("the bookmark slot", () => {
  it("saves the page the user is on, where it is now", async () => {
    await useApp.getState().saveBookmark();
    expect(calls("set_bookmark")).toEqual([
      ["set_bookmark", { url: "https://news.example/story/42", title: "A story" }],
    ]);
    expect(useApp.getState().state?.bookmark?.url).toBe("https://news.example/story/42");
  });

  it("saves nothing while incognito", async () => {
    useApp.setState({ incognito: { active: true, favorites: [], folders: [], busy: false } });
    await useApp.getState().saveBookmark();
    expect(calls("set_bookmark")).toEqual([]);
  });

  it("saves nothing when no page is showing", async () => {
    useApp.setState({ sessions: [], activeId: null });
    await useApp.getState().saveBookmark();
    expect(calls("set_bookmark")).toEqual([]);
  });

  it("switches to the bookmarked page when it is open", () => {
    useApp.setState({
      state: withBookmark({ url: "https://news.example/story/42", title: "A story" }),
      sessions: [page, newSession("other", "typed", "https://other.example/", 2)],
      activeId: "other",
    });
    useApp.getState().openBookmark();
    expect(useApp.getState().activeId).toBe("p");
    expect(useApp.getState().action).toMatchObject({ type: "activate", id: "p" });
  });

  it("opens the bookmarked page in a new session otherwise", () => {
    useApp.setState({ state: withBookmark({ url: "https://saved.example/a", title: "Saved" }) });
    useApp.getState().openBookmark();
    expect(useApp.getState().action).toMatchObject({
      type: "open",
      url: "https://saved.example/a",
      previousId: "p",
    });
  });

  it("empties the slot, and restores it when Rust fails", async () => {
    const saved = { url: "https://saved.example/a", title: "Saved" };
    useApp.setState({ state: withBookmark(saved) });
    await useApp.getState().removeBookmark();
    expect(useApp.getState().state?.bookmark).toBeNull();

    useApp.setState({ state: withBookmark(saved) });
    invoke.mockRejectedValueOnce("library lock poisoned");
    await useApp.getState().removeBookmark();
    expect(useApp.getState().state?.bookmark).toEqual(saved);
  });
});
