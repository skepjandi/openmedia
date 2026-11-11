import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { selectQuickFavorites, useApp } from "./store";
import type { AppState, Favorite } from "../shared/ipc";
import { useEntitlementStore } from "../features/paywall/store";

const favorite = (name: string, url: string): Favorite => ({ id: name, name, url, notify: true });
const normal = [favorite("Reddit", "https://www.reddit.com/")];
const secret = [favorite("Secret", "https://secret.example/")];

const appState = {
  theme: "system",
  locale: "en",
  favorites: normal,
  history: [],
} as unknown as AppState;

const calls = (name: string) => invoke.mock.calls.filter((call) => call[0] === name);

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({
    state: appState,
    sessions: [],
    activeId: null,
    incognito: { active: false, favorites: [], busy: false },
    incognitoSites: [],
    error: null,
  });
  useEntitlementStore.setState({ status: "pro", configured: true, snapshot: null });
});

const names = (favorites: readonly Favorite[]) => favorites.map((entry) => entry.name);

describe("incognito mode", () => {
  it("shows the normal favorites until a biometric check passes", async () => {
    invoke.mockResolvedValue(null);
    await useApp.getState().enterIncognito();
    expect(invoke).toHaveBeenCalledWith("enter_incognito", { reason: expect.any(String) });
    expect(useApp.getState().incognito).toEqual({ active: false, favorites: [], busy: false });
    expect(names(selectQuickFavorites(useApp.getState()))).toEqual(["Reddit"]);
  });

  it("swaps the quick-access set when entered, and drops it again on leaving", async () => {
    invoke.mockImplementation(async (name: string) => (name === "enter_incognito" ? secret : null));
    await useApp.getState().enterIncognito();
    expect(useApp.getState().incognito.active).toBe(true);
    expect(names(selectQuickFavorites(useApp.getState()))).toEqual(["Secret"]);

    await useApp.getState().exitIncognito();
    expect(calls("exit_incognito")).toHaveLength(1);
    expect(useApp.getState().incognito).toEqual({ active: false, favorites: [], busy: false });
    expect(names(selectQuickFavorites(useApp.getState()))).toEqual(["Reddit"]);
  });

  it("drops an open assistant turn when the mode changes, so it cannot be seen in the other mode", async () => {
    invoke.mockImplementation(async (name: string) => (name === "enter_incognito" ? secret : null));
    await useApp.getState().enterIncognito();
    useApp.setState({
      assistant: { status: "idle", draft: "hide the stories from my private feed" },
    });

    await useApp.getState().exitIncognito();

    expect(useApp.getState().assistant).toEqual({ status: "idle", draft: "" });
  });

  it("stays in the normal set and reports the error when the check cannot run", async () => {
    invoke.mockRejectedValue("this device cannot check who is holding it");
    await useApp.getState().enterIncognito();
    expect(useApp.getState().incognito.active).toBe(false);
    expect(useApp.getState().incognito.busy).toBe(false);
    expect(useApp.getState().error).toBeTruthy();
  });

  it("ignores a second press while the check is open", async () => {
    invoke.mockImplementation(async () => secret);
    await Promise.all([useApp.getState().enterIncognito(), useApp.getState().enterIncognito()]);
    expect(calls("enter_incognito")).toHaveLength(1);
    expect(useApp.getState().incognito.active).toBe(true);
  });

  it("opens the paywall instead of requesting biometric access for a free user", async () => {
    useEntitlementStore.setState({ status: "free", configured: true, snapshot: null });
    await useApp.getState().enterIncognito();
    expect(calls("enter_incognito")).toHaveLength(0);
    expect(useApp.getState().sheet).toBe("paywall");
    expect(useApp.getState().incognito.active).toBe(false);
  });

  it("keeps the incognito favorites while it is on, but forgets an unlocked section's copy otherwise", () => {
    useApp.setState({ incognito: { active: false, favorites: secret, busy: false } });
    useApp.getState().forgetIncognitoFavorites();
    expect(useApp.getState().incognito.favorites).toEqual([]);

    useApp.setState({ incognito: { active: true, favorites: secret, busy: false } });
    useApp.getState().forgetIncognitoFavorites();
    expect(useApp.getState().incognito.favorites).toEqual(secret);
  });

  it("saves recipe switches to the incognito set, not the normal one", async () => {
    invoke.mockResolvedValue(undefined);
    useApp.setState({
      incognitoSites: [
        {
          recipeId: "youtube.default",
          name: "YouTube",
          homepage: null,
          hub: null,
          origin: "user",
          favorite: false,
          options: [
            {
              id: "shorts",
              label: "Shorts",
              description: "",
              group: "content",
              enabled: false,
              default: false,
            },
          ],
          bottomMargin: null,
        },
      ],
    });
    await useApp.getState().setIncognitoSiteOption("youtube.default", "shorts", true);
    expect(invoke).toHaveBeenCalledWith("set_site_option", {
      recipeId: "youtube.default",
      optionId: "shorts",
      enabled: true,
      incognito: true,
    });
    expect(useApp.getState().incognitoSites[0].options[0].enabled).toBe(true);
  });
});
