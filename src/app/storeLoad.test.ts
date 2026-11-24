import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";
import type { Startup } from "../shared/ipc";
import { ACCESSIBILITY_OFF } from "../shared/accessibility";
import { DARK_MODE_DEFAULT } from "../shared/darkMode";
import { VIDEO_CONTROLS_DEFAULT } from "../shared/videoControls";

const startup = {
  profileId: "default",
  favorites: [],
  folders: [],
  history: [],
  lastUrl: "https://m.youtube.com/watch?v=example",
  lastBack: [],
  onboarded: true,
  theme: "system",
  adBlock: false,
  blockPopups: true,
  preloadFavorites: true,
  bottomMargin: 0,
  backgroundMediaSites: [],
  pictureInPictureSites: [],
  desktopSites: [],
  backButton: true,
  colorPicker: true,
  techDetector: true,
  bookmarkButton: true,
  aiPreview: true,
  locale: "en",
  searchEngine: "google",
  accessibility: ACCESSIBILITY_OFF,
  videoControls: VIDEO_CONTROLS_DEFAULT,
  videoSites: {},
  darkMode: DARK_MODE_DEFAULT,
  darkSites: {},
  bookmark: null,
  startPage: "lastPage",
  bootSession: { id: "boot-session", url: "https://m.youtube.com/watch?v=example" },
  profiles: { active: "default", profiles: [{ id: "default" }] },
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
