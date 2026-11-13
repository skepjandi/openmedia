import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";
import type { Startup } from "../shared/ipc";

const startup = {
  profileId: "default",
  favorites: [],
  history: [],
  lastUrl: "https://m.youtube.com/watch?v=example",
  lastBack: [],
  onboarded: true,
  theme: "system",
  adBlock: false,
  bottomMargin: 0,
  backgroundMediaSites: [],
  backButton: true,
  aiPreview: true,
  locale: "en",
  searchEngine: "google",
  bootSession: { id: "boot-session", url: "https://m.youtube.com/watch?v=example" },
  desktop: false,
} satisfies Startup;

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(startup);
  useApp.setState({ sessions: [], activeId: null, action: null, state: null });
});

describe("app startup", () => {
  it("does not add the same boot session twice when startup loads overlap", async () => {
    await Promise.all([useApp.getState().load(), useApp.getState().load()]);

    expect(useApp.getState().sessions.map((session) => session.id)).toEqual(["boot-session"]);
  });
});
